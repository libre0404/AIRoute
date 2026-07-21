/*
 * hermes_core.c — HERMES initialization, configuration, lifecycle, and statistics
 *
 * This file implements the core management functions declared in hermes.h.
 * Layer-specific implementations are in:
 *   hermes_l1.c   — L1 expert prediction
 *   hermes_l23.c  — L2 compression + L3 precision
 *   hermes_l4.c   — L4 Vulkan compute (stub)
 *
 * Integration with colibrì:
 *   1. In glm.c, add:  #define HERMES 1
 *                      #include "hermes/hermes.h"
 *   2. Call hermes_init() after model load (before inference loop)
 *   3. Insert hermes_hook1_predict() in moe() after routing
 *   4. Insert hermes_hook2_postload() in expert_load() after pread
 *   5. Insert hermes_hook3_compute() before CPU expert matmul
 *   6. Call hermes_shutdown() at exit
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "hermes.h"

/* ── Global context ──────────────────────────────────────────── */
HermesCtx g_hermes;

/* ── Environment variable helpers ────────────────────────────── */

static int env_int(const char *name, int dflt) {
    const char *s = getenv(name);
    return s ? atoi(s) : dflt;
}

static float env_float(const char *name, float dflt) {
    const char *s = getenv(name);
    return s ? (float)atof(s) : dflt;
}

static const char *env_str(const char *name, const char *dflt) {
    const char *s = getenv(name);
    return s ? s : dflt;
}

/* ── Initialization ──────────────────────────────────────────── */

int hermes_init(int n_layers, int n_experts, int expert_dim,
                int expert_inter, int top_k)
{
    memset(&g_hermes, 0, sizeof(g_hermes));

    if (!env_int("HERMES", 0)) {
        return 0;  /* not enabled — not an error */
    }

    g_hermes.n_layers    = n_layers;
    g_hermes.n_experts   = n_experts;
    g_hermes.expert_dim  = expert_dim;
    g_hermes.expert_inter = expert_inter;
    g_hermes.top_k       = top_k;

    pthread_mutex_init(&g_hermes.mtx, NULL);

    /* ── L1: Expert Prediction ─────────────────────────────── */
#ifdef HERMES_L1
    {
        HermesL1State *l1 = &g_hermes.l1;
        l1->poe.w_hs  = env_float("HERMES_L1_W_HS",  0.5f);
        l1->poe.w_co  = env_float("HERMES_L1_W_CO",  0.2f);
        l1->poe.w_dom = env_float("HERMES_L1_W_DOM", 0.2f);
        l1->poe.w_mtp = env_float("HERMES_L1_W_MTP", 0.1f);
        l1->calib_phase  = 0;   /* cold start */
        l1->calib_count  = 0;

        int E  = n_experts;
        int D  = HERMES_EMBED_DIM;

        l1->em.n_experts  = E;
        l1->em.embed_dim  = D;
        l1->em.embeddings = calloc((size_t)E * D, sizeof(float));

        /* CSR co-activation graph (initially empty) */
        l1->em.coact_idx  = calloc(E + 1, sizeof(int));
        l1->em.coact_cols = NULL;
        l1->em.coact_vals = NULL;

        /* Domain assignments */
        l1->em.domain_id  = calloc(E, sizeof(int));
        l1->em.n_domains  = 0;

        /* Hidden state buffer */
        l1->last_hs       = calloc(D, sizeof(float));

        /* Seed random generator */
        srand(42);

        /* Initialize embeddings */
        const char *emb_path = env_str("HERMES_EMBED", NULL);
        if (emb_path) {
            /* TODO: load pre-trained embeddings from binary file */
            fprintf(stderr, "[HERMES] L1: loading embeddings from %s\n", emb_path);
            for (int i = 0; i < E * D; i++)
                l1->em.embeddings[i] = (float)(rand() % 2000 - 1000) / 1000.0f * 0.1f;
            l1->calib_phase = 1;  /* warm-up */
        } else {
            /* Cold start: small random init */
            for (int i = 0; i < E * D; i++)
                l1->em.embeddings[i] = (float)(rand() % 2000 - 1000) / 1000.0f * 0.01f;
            l1->calib_phase = 0;
        }

        fprintf(stderr,
            "[HERMES] L1 predictor: E=%d, D=%d, PoE(%.1f/%.1f/%.1f/%.1f), phase=%d\n",
            E, D, l1->poe.w_hs, l1->poe.w_co, l1->poe.w_dom, l1->poe.w_mtp,
            l1->calib_phase);
    }
#endif /* HERMES_L1 */

    /* ── L2: Per-domain Dictionary Compression ─────────────── */
#ifdef HERMES_L2
    {
        HermesL2State *l2 = &g_hermes.l2;
        int total = n_layers * n_experts;

        l2->n_domains = 0;  /* will be set after L1 domain assignment */
        l2->k         = HERMES_DICT_K;
        l2->s         = HERMES_DICT_S;
        l2->atom_dim  = expert_inter;

        l2->comp_level  = calloc(total, sizeof(int8_t));
        l2->orig_bytes  = calloc(total, sizeof(int64_t));
        l2->comp_bytes  = calloc(total, sizeof(int64_t));

        /* Default: all experts at C2 (dict + LZ4) */
        memset(l2->comp_level, HERMES_COMP_DICT, total);

        const char *dict_path = env_str("HERMES_DICT", NULL);
        if (dict_path) {
            fprintf(stderr, "[HERMES] L2: loading dictionaries from %s\n", dict_path);
            /* TODO: load K-SVD dictionaries */
        } else {
            /* No pre-trained dictionaries; use LZ4-only (C1) for now */
            memset(l2->comp_level, HERMES_COMP_LZ4, total);
        }

        fprintf(stderr,
            "[HERMES] L2 compression: K=%d, S=%d, %d experts\n",
            l2->k, l2->s, total);
    }
#endif /* HERMES_L2 */

    /* ── L3: Dynamic Mixed-Precision ───────────────────────── */
#ifdef HERMES_L3
    {
        HermesL3State *l3 = &g_hermes.l3;
        int total = n_layers * n_experts;

        l3->sensitivity         = calloc(total, sizeof(float));
        l3->precision           = calloc(total, sizeof(int8_t));
        l3->expert_uncertainty  = calloc(n_experts, sizeof(float));
        l3->token_difficulty_ema = 0.0f;
        l3->phase               = HERMES_L3_OFFLINE;

        /* Default: int4 for all experts */
        memset(l3->precision, HERMES_FMT_INT4, total);
        l3->n_int2 = 0;
        l3->n_int4 = total;
        l3->n_int8 = 0;

        const char *sens_path = env_str("HERMES_SENS", NULL);
        if (sens_path) {
            /* TODO: load sensitivity profile from file */
            fprintf(stderr, "[HERMES] L3: loading sensitivity from %s\n", sens_path);
            l3->phase = HERMES_L3_ONLINE;

            /* GLM-5.2 default distribution: ~18% int8, ~70% int4, ~12% int2 */
            int n8  = (int)(total * 0.18);
            int n2  = (int)(total * 0.12);
            int n4  = total - n8 - n2;
            for (int i = 0;       i < n8;          i++) l3->precision[i] = HERMES_FMT_INT8;
            for (int i = n8;      i < n8 + n4;     i++) l3->precision[i] = HERMES_FMT_INT4;
            for (int i = n8 + n4; i < total;       i++) l3->precision[i] = HERMES_FMT_INT2;
            l3->n_int8 = n8;
            l3->n_int4 = n4;
            l3->n_int2 = n2;
        }

        fprintf(stderr,
            "[HERMES] L3 precision: int8=%d, int4=%d, int2=%d, phase=%d\n",
            l3->n_int8, l3->n_int4, l3->n_int2, l3->phase);
    }
#endif /* HERMES_L3 */

    /* ── L4: Vulkan Compute (stub) ─────────────────────────── */
#ifdef HERMES_L4
    {
        fprintf(stderr, "[HERMES] L4: Vulkan compiled (runtime init deferred)\n");
        /* TODO: hermes_l4_init() — Vulkan device discovery, shader loading */
    }
#endif

    g_hermes.initialized = 1;
    fprintf(stderr,
        "[HERMES] Ready: %d layers × %d experts (dim=%d, inter=%d, k=%d)\n",
        n_layers, n_experts, expert_dim, expert_inter, top_k);

    return 0;
}

/* ── Shutdown ────────────────────────────────────────────────── */

void hermes_shutdown(void)
{
    if (!g_hermes.initialized) return;

#ifdef HERMES_L1
    {
        HermesL1State *l1 = &g_hermes.l1;
        free(l1->em.embeddings);
        free(l1->em.coact_idx);
        free(l1->em.coact_cols);
        free(l1->em.coact_vals);
        free(l1->em.domain_id);
        free(l1->last_hs);
    }
#endif
#ifdef HERMES_L2
    {
        HermesL2State *l2 = &g_hermes.l2;
        free(l2->comp_level);
        free(l2->orig_bytes);
        free(l2->comp_bytes);
        free(l2->dict);
    }
#endif
#ifdef HERMES_L3
    {
        HermesL3State *l3 = &g_hermes.l3;
        free(l3->sensitivity);
        free(l3->precision);
        free(l3->expert_uncertainty);
    }
#endif
#ifdef HERMES_L4
    /* TODO: hermes_l4_cleanup() */
#endif

    pthread_mutex_destroy(&g_hermes.mtx);
    memset(&g_hermes, 0, sizeof(g_hermes));
    fprintf(stderr, "[HERMES] Shutdown complete\n");
}

/* ── Statistics ──────────────────────────────────────────────── */

void hermes_get_stats(HermesStats *stats)
{
    memset(stats, 0, sizeof(*stats));
    if (!g_hermes.initialized) return;

    stats->tokens         = g_hermes.total_tokens;
    stats->expert_loads   = g_hermes.total_expert_loads;
    stats->cache_hits     = g_hermes.total_cache_hits;
    stats->prefetch_hits  = g_hermes.total_prefetch_hits;

    if (g_hermes.total_expert_loads > 0)
        stats->cache_hit_rate =
            (double)g_hermes.total_cache_hits / g_hermes.total_expert_loads;

#ifdef HERMES_L1
    if (g_hermes.l1.n_prefetch_issued > 0)
        stats->prefetch_hit_rate =
            (double)g_hermes.l1.n_prefetch_hits / g_hermes.l1.n_prefetch_issued;
    if (g_hermes.l1.n_predictions > 0)
        stats->avg_precision =
            (double)g_hermes.l1.n_hits / g_hermes.l1.n_predictions;
#endif
#ifdef HERMES_L2
    if (g_hermes.l2.total_bytes_in > 0)
        stats->compression_ratio =
            (double)g_hermes.l2.total_bytes_in / g_hermes.l2.total_bytes_out;
#endif
#ifdef HERMES_L3
    {
        int total = g_hermes.l3.n_int8 + g_hermes.l3.n_int4 + g_hermes.l3.n_int2;
        if (total > 0)
            stats->avg_bits =
                (8.0 * g_hermes.l3.n_int8 +
                 4.0 * g_hermes.l3.n_int4 +
                 2.0 * g_hermes.l3.n_int2) / total;
    }
#endif
#ifdef HERMES_L4
    stats->gpu_dispatches  = (int)g_hermes.l4.n_dispatches;
    stats->gpu_fallbacks   = (int)g_hermes.l4.n_fallbacks;
#endif
}

void hermes_print_stats(void)
{
    HermesStats s;
    hermes_get_stats(&s);
    fprintf(stderr, "═══════════════════════════════════════════════════\n");
    fprintf(stderr, "  HERMES Statistics\n");
    fprintf(stderr, "═══════════════════════════════════════════════════\n");
    fprintf(stderr, "  Tokens:           %lld\n", (long long)s.tokens);
    fprintf(stderr, "  Expert loads:     %lld\n", (long long)s.expert_loads);
    fprintf(stderr, "  Cache hits:       %lld (%.1f%%)\n",
            (long long)s.cache_hits, s.cache_hit_rate * 100.0);
    fprintf(stderr, "  Prefetch hits:    %lld (%.1f%%)\n",
            (long long)s.prefetch_hits, s.prefetch_hit_rate * 100.0);
    fprintf(stderr, "  Pred precision:   %.1f%%\n", s.avg_precision * 100.0);
    fprintf(stderr, "  Comp ratio:       %.2fx\n", s.compression_ratio);
    fprintf(stderr, "  Avg precision:    %.1f bits\n", s.avg_bits);
    fprintf(stderr, "  GPU dispatches:   %d (fallback: %d)\n",
            s.gpu_dispatches, s.gpu_fallbacks);
    fprintf(stderr, "═══════════════════════════════════════════════════\n");
}
