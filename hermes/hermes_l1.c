/*
 * hermes_l1.c — L1 Expert Prediction
 *
 * Implements the four-signal Product-of-Experts (PoE) predictor:
 *   1. Quasi-HS similarity  (w=0.5): routing weight as proxy for
 *      hidden-state-to-expert affinity
 *   2. Co-activation         (w=0.2): historical co-occurrence frequency
 *      from ring buffer (warm-up) or CSR graph (online)
 *   3. Domain affinity       (w=0.2): experts in same domain cluster
 *   4. MTP lookahead         (w=0.1): draft-token routing prediction
 *      (stub — connects to colibrì's mtp_draft pipeline)
 *
 * Prediction target: experts needed at layer L+1 and next token T+1,
 * issued as prefetch requests to colibrì's I/O pipeline.
 *
 * Candidate set construction avoids O(E) scanning:
 *   candidates = currently_routed ∪ recent_history ∪ coact_neighbors
 *   typically 50-600 candidates (vs E=19,456 for GLM-5.2)
 */

#include "hermes.h"
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* ════════════════════════════════════════════════════════════════
 *  Internal utilities
 * ════════════════════════════════════════════════════════════════ */

/* Numerically stable softmax over n float values */
static void softmax_inplace(float *v, int n)
{
    if (n <= 0) return;
    float mx = v[0];
    for (int i = 1; i < n; i++)
        if (v[i] > mx) mx = v[i];
    float sum = 0.0f;
    for (int i = 0; i < n; i++) {
        v[i] = expf(v[i] - mx);
        sum += v[i];
    }
    if (sum > 0.0f)
        for (int i = 0; i < n; i++)
            v[i] /= sum;
}

/* O(n*k) partial selection — k must be <= n */
static int topk_partial(float *scores, int *idx, int n, int k)
{
    if (k > n) k = n;
    if (k <= 0) return 0;
    for (int i = 0; i < k; i++) {
        int best = i;
        for (int j = i + 1; j < n; j++)
            if (scores[j] > scores[best]) best = j;
        if (best != i) {
            float ts = scores[i]; scores[i] = scores[best]; scores[best] = ts;
            int   ti = idx[i];    idx[i]    = idx[best];    idx[best]    = ti;
        }
    }
    return k;
}

/* Count occurrences of eid in the history ring buffer */
static int history_count(const HermesL1State *l1, int eid)
{
    int cnt = 0;
    for (int i = 0; i < l1->hist_count; i++)
        if (l1->history[i] == eid) cnt++;
    return cnt;
}

/* Build candidate set: currently-routed ∪ recent-history */
static int build_candidates(
    const int *cur_eids, int n_cur,
    const HermesL1State *l1,
    int *out,           /* [max_out] */
    int max_out)
{
    int n = 0;
    /* Currently-routed experts */
    for (int j = 0; j < n_cur && n < max_out; j++) {
        int e = cur_eids[j];
        if (e < 0) continue;
        int dup = 0;
        for (int i = 0; i < n; i++) if (out[i] == e) { dup = 1; break; }
        if (!dup) out[n++] = e;
    }
    /* Recent history experts */
    for (int i = 0; i < l1->hist_count && n < max_out; i++) {
        int e = l1->history[i];
        if (e < 0) continue;
        int dup = 0;
        for (int j = 0; j < n; j++) if (out[j] == e) { dup = 1; break; }
        if (!dup) out[n++] = e;
    }
    return n;
}

/* ════════════════════════════════════════════════════════════════
 *  Signal 1: Quasi-HS similarity
 * ════════════════════════════════════════════════════════════════ */

/*
 * When hidden state is available, compute dot product between mean HS
 * and expert embeddings.  Otherwise, fall back to routing weights as
 * a proxy (experts that received high routing weight are likely needed
 * in adjacent layers too — spatial locality).
 */
static float signal_hs(
    const HermesL1State *l1,
    int layer, int S, int K,
    const int *routed_eids, const float *routed_ws,
    const float *hidden_state,
    int eid)
{
    /* If we have hidden state and embeddings, use proper similarity */
    if (hidden_state && l1->em.embeddings && l1->calib_phase >= 1) {
        int dim = l1->em.embed_dim;
        if (g_hermes.expert_dim < dim) dim = g_hermes.expert_dim;
        const float *emb = l1->em.embeddings + (size_t)eid * l1->em.embed_dim;
        float dot = 0.0f;
        for (int s = 0; s < S; s++) {
            const float *x = hidden_state + (size_t)s * g_hermes.expert_dim;
            for (int d = 0; d < dim; d++)
                dot += x[d] * emb[d];
        }
        /* Normalize to [-1, 1]-ish range */
        return dot / (float)(S * dim + 1);
    }

    /* Fallback: routing weight proxy.
       If this expert was routed to in this step, use its weight. */
    for (int j = 0; j < S * K; j++) {
        if (routed_eids[j] == eid) return routed_ws[j];
    }
    /* Not routed this step — small prior from history frequency */
    int h_cnt = history_count(l1, eid);
    return l1->hist_count > 0
        ? (float)h_cnt / l1->hist_count * 0.5f
        : 0.0f;
}

/* ════════════════════════════════════════════════════════════════
 *  Signal 2: Co-activation
 * ════════════════════════════════════════════════════════════════ */

/*
 * Co-activation score: how often has eid co-occurred with
 * currently-routed experts in the recent history?
 *
 * Warm-up (phase 0-1): history-based heuristic.
 * Online (phase 2): CSR graph binary-search lookup.
 */
static float signal_coactivation(
    const HermesL1State *l1,
    const int *cur_eids, int n_cur,
    int eid)
{
    /* --- CSR graph path (online phase) --- */
    if (l1->calib_phase >= 2 && l1->em.coact_cols && l1->em.coact_idx) {
        float score = 0.0f;
        for (int j = 0; j < n_cur; j++) {
            int e = cur_eids[j];
            if (e == eid || e < 0) continue;
            /* Binary search for e in eid's neighbor list */
            int lo = l1->em.coact_idx[eid];
            int hi = l1->em.coact_idx[eid + 1];
            while (lo < hi) {
                int mid = lo + (hi - lo) / 2;
                int col = l1->em.coact_cols[mid];
                if (col == e) { score += l1->em.coact_vals[mid]; break; }
                else if (col < e) lo = mid + 1;
                else hi = mid;
            }
        }
        return score;
    }

    /* --- History-based heuristic (warm-up) --- */
    /* Approximate co-activation via joint history frequency */
    float score = 0.0f;
    for (int j = 0; j < n_cur; j++) {
        int e = cur_eids[j];
        if (e == eid || e < 0) continue;
        /* Both appeared in history → likely co-activate */
        int freq_e   = history_count(l1, e);
        int freq_eid = history_count(l1, eid);
        /* Geometric mean of frequencies as co-activation proxy */
        score += sqrtf((float)freq_e * (float)freq_eid);
    }
    /* Normalize */
    return l1->hist_count > 0 ? score / l1->hist_count : 0.0f;
}

/* ════════════════════════════════════════════════════════════════
 *  Signal 3: Domain affinity
 * ════════════════════════════════════════════════════════════════ */

static float signal_domain(
    const HermesL1State *l1,
    const int *cur_eids, int n_cur,
    int eid)
{
    if (l1->em.n_domains <= 0 || !l1->em.domain_id) return 0.0f;
    if (eid < 0 || eid >= l1->em.n_experts) return 0.0f;

    int dom_eid = l1->em.domain_id[eid];
    int same = 0;
    for (int j = 0; j < n_cur; j++) {
        int e = cur_eids[j];
        if (e >= 0 && e < l1->em.n_experts && l1->em.domain_id[e] == dom_eid)
            same++;
    }
    return n_cur > 0 ? (float)same / n_cur : 0.0f;
}

/* ════════════════════════════════════════════════════════════════
 *  Signal 4: MTP lookahead (stub)
 * ════════════════════════════════════════════════════════════════ */

/*
 * Full implementation: use colibrì's mtp_draft() output to predict
 * routing for the next G tokens, then score candidate experts.
 *
 * Integration: colibrì calls hermes_set_mtp_draft() before
 * hermes_l1_predict(), passing the draft token IDs.  The predictor
 * then runs a quick router forward pass (using cached router weights)
 * to predict expert routing for each draft token.
 *
 * Stub: returns 0.0 (no MTP signal).
 */
static float signal_mtp(
    const HermesL1State *l1,
    int eid)
{
    (void)l1; (void)eid;
    /* TODO: connect to colibrì mtp_draft pipeline */
    return 0.0f;
}

/* ════════════════════════════════════════════════════════════════
 *  Public API: Prediction
 * ════════════════════════════════════════════════════════════════ */

int hermes_l1_predict(
    int         layer,
    int         S,
    int         K,
    const int  *routed_eids,     /* [S × K] */
    const float *routed_ws,      /* [S × K] */
    const float *hidden_state,    /* [S × expert_dim], may be NULL */
    HermesPred *out_preds,        /* [max_out] */
    int        *out_pred_layers,  /* [max_out] */
    int         max_out)
{
    HermesL1State *l1 = &g_hermes.l1;
    if (!g_hermes.initialized || max_out <= 0) return 0;

    int n_cur = S * K;

    /* Build candidate set */
    int candidates[HERMES_MAX_PREFETCH * 2];
    int n_cand = build_candidates(routed_eids, n_cur, l1,
                                  candidates, HERMES_MAX_PREFETCH);
    if (n_cand == 0) return 0;

    /* Score each candidate via PoE fusion */
    float scores[HERMES_MAX_PREFETCH * 2];
    for (int i = 0; i < n_cand; i++) {
        int eid = candidates[i];

        float s_hs  = signal_hs(l1, layer, S, K,
                                routed_eids, routed_ws, hidden_state, eid);
        float s_co  = signal_coactivation(l1, routed_eids, n_cur, eid);
        float s_dom = signal_domain(l1, routed_eids, n_cur, eid);
        float s_mtp = signal_mtp(l1, eid);

        scores[i] = l1->poe.w_hs  * s_hs
                  + l1->poe.w_co  * s_co
                  + l1->poe.w_dom * s_dom
                  + l1->poe.w_mtp * s_mtp;
    }

    /* Softmax normalize scores */
    softmax_inplace(scores, n_cand);

    /* Confidence threshold: skip low-confidence predictions */
    float threshold = 0.01f;

    /* Select top-k predictions for layer L+1 */
    int n_pred = 0;
    int k_next = max_out / 2;   /* budget for inter-layer (L→L+1) */
    if (k_next > 8) k_next = 8;

    if (layer + 1 < g_hermes.n_layers && k_next > 0) {
        int selected = topk_partial(scores, candidates, n_cand, k_next);
        for (int i = 0; i < selected && n_pred < max_out; i++) {
            if (scores[i] < threshold) break;
            out_preds[n_pred].eid   = candidates[i];
            out_preds[n_pred].score = scores[i];
            out_pred_layers[n_pred] = layer + 1;
            n_pred++;
        }
    }

    /* Also predict for current layer (temporal locality: next token T+1) */
    int k_same = max_out - n_pred;
    if (k_same > 8) k_same = 8;

    if (k_same > 0 && n_cand > k_next) {
        /* Reuse remaining candidates (skip those already selected) */
        int start = n_cand < k_next ? n_cand : k_next;
        for (int i = start; i < n_cand && n_pred < max_out; i++) {
            if (scores[i] < threshold) break;
            out_preds[n_pred].eid   = candidates[i];
            out_preds[n_pred].score = scores[i];
            out_pred_layers[n_pred] = layer;
            n_pred++;
        }
    }

    /* Update statistics (thread-safe) */
    pthread_mutex_lock(&g_hermes.mtx);
    l1->n_predictions      += n_pred;
    l1->n_prefetch_issued  += n_pred;
    pthread_mutex_unlock(&g_hermes.mtx);

    return n_pred;
}

/* ════════════════════════════════════════════════════════════════
 *  Public API: Online update
 * ════════════════════════════════════════════════════════════════ */

void hermes_l1_update(
    int         layer,
    int         S,
    int         K,
    const int  *routed_eids,     /* [S × K] */
    const float *routed_ws)      /* [S × K] */
{
    HermesL1State *l1 = &g_hermes.l1;
    if (!g_hermes.initialized) return;

    pthread_mutex_lock(&g_hermes.mtx);

    /* 1. Push routing results into history ring buffer */
    for (int j = 0; j < S * K; j++) {
        int e = routed_eids[j];
        if (e >= 0 && e < g_hermes.n_experts) {
            l1->history[l1->hist_head] = e;
            l1->hist_head = (l1->hist_head + 1) % HERMES_HISTORY_LEN;
            if (l1->hist_count < HERMES_HISTORY_LEN) l1->hist_count++;
        }
    }

    /* 2. Update hidden state buffer (for HS similarity in next call) */
    /* Caller should pass hidden_state in hermes_l1_predict; we don't
       store it here to avoid extra copies. */

    /* 3. Calibration phase transitions */
    l1->calib_count++;
    if (l1->calib_phase == 0 && l1->calib_count >= 100) {
        l1->calib_phase = 1;  /* cold start → warm-up */
        fprintf(stderr, "[HERMES] L1: cold start → warm-up (100 tokens)\n");
    } else if (l1->calib_phase == 1 && l1->calib_count >= 500) {
        l1->calib_phase = 2;  /* warm-up → online */
        fprintf(stderr, "[HERMES] L1: warm-up → online (500 tokens)\n");
        /* TODO: build CSR co-activation graph from history */
        /* TODO: assign domains via spectral clustering on co-activation matrix */
    }

    /* 4. Track prefetch hits (called by colibrì when a prefetched
          expert is actually used) */
    g_hermes.total_tokens += S;

    pthread_mutex_unlock(&g_hermes.mtx);
}

/* ════════════════════════════════════════════════════════════════
 *  Prefetch hit tracking (called by colibrì when prefetched expert used)
 * ════════════════════════════════════════════════════════════════ */
void hermes_l1_mark_prefetch_hit(int layer, int eid)
{
    (void)layer; (void)eid;
    HermesL1State *l1 = &g_hermes.l1;
    pthread_mutex_lock(&g_hermes.mtx);
    l1->n_prefetch_hits++;
    g_hermes.total_prefetch_hits++;
    pthread_mutex_unlock(&g_hermes.mtx);
}

/*
 * Build CSR co-activation graph from accumulated history.
 * Called once when transitioning from warm-up to online phase.
 *
 * For each pair (e1, e2) that appeared in the same routing step,
 * weight = co-occurrence count / total steps.
 * Only pairs with weight > threshold are included.
 */
void hermes_l1_build_coact_graph(void)
{
    HermesL1State *l1 = &g_hermes.l1;
    if (l1->hist_count == 0) return;

    int E = l1->em.n_experts;

    /* Count co-occurrence using a dense temporary matrix.
       For E <= 4096 this is at most 4096^2 * 4 = 64 MB (acceptable).
       For larger E, use a hash table (TODO). */
    if (E > 4096) {
        fprintf(stderr, "[HERMES] L1: E=%d > 4096, skipping dense graph build\n", E);
        return;
    }

    size_t mat_size = (size_t)E * E;
    float *dense = calloc(mat_size, sizeof(float));
    if (!dense) {
        fprintf(stderr, "[HERMES] L1: failed to allocate co-act matrix (%zu bytes)\n",
                mat_size * sizeof(float));
        return;
    }

    /* Populate co-occurrence from history ring buffer.
       Each step contributes S*K entries; we treat all experts in the
       same "step window" as co-activating.
       For simplicity, treat every K consecutive entries as one step. */
    int step_size = g_hermes.top_k;
    if (step_size < 1) step_size = 1;

    for (int i = 0; i + step_size <= l1->hist_count; i += step_size) {
        for (int a = 0; a < step_size; a++) {
            for (int b = a + 1; b < step_size; b++) {
                int ea = l1->history[i + a];
                int eb = l1->history[i + b];
                if (ea >= 0 && ea < E && eb >= 0 && eb < E) {
                    dense[(size_t)ea * E + eb] += 1.0f;
                    dense[(size_t)eb * E + ea] += 1.0f;
                }
            }
        }
    }

    /* Count non-zero entries (weight > threshold) */
    float thresh = 0.5f;  /* at least half a co-occurrence */
    int nnz = 0;
    for (int i = 0; i < E; i++)
        for (int j = i + 1; j < E; j++)
            if (dense[(size_t)i * E + j] > thresh) nnz++;

    /* Build CSR (upper triangular only — symmetric graph) */
    free(l1->em.coact_cols);
    free(l1->em.coact_vals);
    l1->em.coact_idx[0] = 0;
    l1->em.coact_cols = nnz > 0 ? malloc(nnz * sizeof(int))   : NULL;
    l1->em.coact_vals = nnz > 0 ? malloc(nnz * sizeof(float)) : NULL;

    int pos = 0;
    for (int i = 0; i < E; i++) {
        for (int j = i + 1; j < E; j++) {
            float w = dense[(size_t)i * E + j];
            if (w > thresh) {
                l1->em.coact_cols[pos] = j;
                l1->em.coact_vals[pos] = w / (float)l1->hist_count;
                pos++;
            }
        }
        l1->em.coact_idx[i + 1] = pos;
    }

    free(dense);

    fprintf(stderr, "[HERMES] L1: built co-activation graph: %d edges (nnz=%d)\n",
            E, nnz);
}
