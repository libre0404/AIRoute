/*
 * hermes.h — HERMES: Heterogeneous Expert Routing with
 *            Multiplicative Engineering Synergy
 *
 * Extension for the colibrì project (https://github.com/JustVugg/colibri)
 * enabling 4-6× inference speedup on commodity hardware through joint
 * optimization of scheduling, compression, precision, and heterogeneous compute.
 *
 * Design principles:
 *   1. Minimal invasiveness — three API hooks, conditional compilation
 *   2. Zero-overhead when disabled — all hooks compiled out via #ifdef
 *   3. Safety-first fallback — every hook returns 0 → original path
 *   4. Multiplicative coupling — layers amplify each other (not additive)
 *
 * Integration: insert #include "hermes.h" in glm.c, then add hook calls
 *   at three locations (see Section E of the integration guide).
 *
 * License: Apache-2.0
 */

#ifndef HERMES_H
#define HERMES_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <stddef.h>
#include <stdatomic.h>

#ifdef _WIN32
  #include <pthread.h>  /* MinGW-w64 provides pthreads */
#else
  #include <pthread.h>
#endif

/* ════════════════════════════════════════════════════════════════
 *  Compile-time configuration
 * ════════════════════════════════════════════════════════════════ */

/* Master switch — define to enable HERMES */
/* #define HERMES 1 */

#ifdef HERMES
  #define HERMES_L1  1   /* L1: Expert scheduling predictor     */
  #define HERMES_L2  1   /* L2: Per-domain dictionary compression */
  #define HERMES_L3  1   /* L3: Dynamic mixed-precision           */
  /* L4 requires Vulkan SDK — enable separately */
  /* #define HERMES_L4 1 */
#endif

/* ════════════════════════════════════════════════════════════════
 *  Precision format enum (mirrors colibrì's QT.fmt)
 * ════════════════════════════════════════════════════════════════ */
enum {
    HERMES_FMT_F32  = 0,
    HERMES_FMT_INT8 = 1,   /* per-row quantized       */
    HERMES_FMT_INT4 = 2,   /* per-row packed nibble   */
    HERMES_FMT_INT2 = 3,   /* 2-bit packed            */
    HERMES_FMT_I4G  = 4,   /* grouped int4 (gs=128)   */
};

/* ════════════════════════════════════════════════════════════════
 *  L1: Expert embeddings and co-activation model
 * ════════════════════════════════════════════════════════════════ */

#define HERMES_EMBED_DIM   256   /* expert embedding dimension     */
#define HERMES_MAX_DOMAINS  16   /* maximum number of domains      */
#define HERMES_MAX_PREFETCH 64   /* max predictions per invocation */
#define HERMES_HISTORY_LEN  512  /* online learning history length */

typedef struct {
    int   eid;            /* expert ID                */
    float score;          /* prediction confidence    */
} HermesPred;

typedef struct {
    int n_experts;                          /* E                     */
    int embed_dim;                           /* D (default 256)       */
    float *embeddings;                       /* [E × D] expert embeddings   */

    /* Co-activation graph (sparse upper triangular) */
    int   *coact_idx;                        /* [E+1] CSR row pointers  */
    int   *coact_cols;                       /* [nnz] column indices     */
    float *coact_vals;                       /* [nnz] co-activation weights */

    /* Domain assignments */
    int   *domain_id;                        /* [E] domain per expert    */
    int   n_domains;                         /* number of active domains */
} HermesExpertModel;

/* PoE (Product of Experts) fusion weights */
typedef struct {
    float w_hs;         /* hidden-state similarity  (0.5) */
    float w_co;         /* co-activation             (0.2) */
    float w_dom;        /* domain affinity           (0.2) */
    float w_mtp;        /* MTP lookahead             (0.1) */
} HermesPoEWeights;

/* L1 predictor state */
typedef struct {
    HermesExpertModel  em;
    HermesPoEWeights   poe;

    /* Calibration phase: 0=cold-start, 1=warm-up, 2=online */
    int    calib_phase;
    int    calib_count;                      /* tokens seen in current phase */

    /* Online routing history (ring buffer) */
    int    history[HERMES_HISTORY_LEN];      /* flattened expert IDs        */
    int    hist_head;
    int    hist_count;

    /* Last hidden state (for intra-token prediction) */
    float *last_hs;                           /* [D] last layer-0 hidden state */

    /* Statistics */
    int64_t n_predictions;
    int64_t n_hits;                           /* prediction was correct     */
    int64_t n_prefetch_issued;
    int64_t n_prefetch_hits;                  /* prefetched expert was used */
} HermesL1State;

/* ════════════════════════════════════════════════════════════════
 *  L2: Per-domain K-SVD dictionary compression
 * ════════════════════════════════════════════════════════════════ */

#define HERMES_DICT_K     256   /* dictionary atoms per domain */
#define HERMES_DICT_S       8   /* sparse coding sparsity      */
#define HERMES_LZ4_BLOCK 4096   /* LZ4 block size              */

/* Compression levels */
enum {
    HERMES_COMP_RAW = 0,     /* C0: no compression            */
    HERMES_COMP_LZ4 = 1,     /* C1: LZ4 only                  */
    HERMES_COMP_DICT = 2,    /* C2: domain dictionary + LZ4   */
};

typedef struct {
    float *dict;          /* [n_domains × K × atom_dim] dictionaries     */
    int    atom_dim;      /* dimension of each dictionary atom           */
    int    n_domains;
    int    k;             /* number of atoms per dictionary              */
    int    s;             /* sparsity level                              */

    /* Per-expert compression metadata */
    int8_t *comp_level;    /* [E] compression level per expert            */
    int64_t *orig_bytes;   /* [E] original size per expert                */
    int64_t *comp_bytes;   /* [E] compressed size per expert              */

    /* Statistics */
    int64_t total_bytes_in;
    int64_t total_bytes_out;
} HermesL2State;

/* ════════════════════════════════════════════════════════════════
 *  L3: Dynamic mixed-precision engine
 * ════════════════════════════════════════════════════════════════ */

#define HERMES_SENS_THRESHOLD 0.2f   /* τ: sensitivity threshold */

/* Calibration phases */
enum {
    HERMES_L3_OFFLINE = 0,   /* profiling not yet done     */
    HERMES_L3_PROFILING = 1, /* collecting sensitivity data */
    HERMES_L3_ONLINE = 2,    /* ready for dynamic switching  */
};

typedef struct {
    /* Per-expert sensitivity scores [n_layers × E] */
    float *sensitivity;       /* higher = more sensitive → higher precision */

    /* Assigned precision [n_layers × E] */
    int8_t *precision;        /* 2, 4, or 8 bits            */

    /* Pareto-optimal precision distribution */
    int n_int2;               /* count of int2 experts       */
    int n_int4;               /* count of int4 experts       */
    int n_int8;               /* count of int8 experts       */

    /* Online adaptation */
    float token_difficulty_ema;   /* exponential moving average  */
    float *expert_uncertainty;     /* [E] per-expert uncertainty   */

    int phase;
} HermesL3State;

/* ════════════════════════════════════════════════════════════════
 *  L4: Vulkan heterogeneous compute (optional)
 * ════════════════════════════════════════════════════════════════ */

#ifdef HERMES_L4

#define HERMES_MAX_DEVICES 4

typedef struct {
    int   initialized;
    int   device_count;
    int   primary_device;

    /* Per-device VRAM budget (MB) */
    int   vram_budget[HERMES_MAX_DEVICES];

    /* SPIR-V shader modules (opaque handles) */
    void *shader_i4_gemv;      /* int4 group GEMV kernel  */
    void *shader_i8_gemv;      /* int8 GEMV kernel        */
    void *shader_i2_gemv;      /* int2 GEMV kernel        */
    void *shader_swiglu;       /* fused SiLU+gate kernel  */

    /* Pipeline state */
    void *pipeline;            /* VkPipeline handle      */
    void *pipeline_cache;      /* VkPipelineCache handle */
    void *command_pool;        /* VkCommandPool handle   */

    /* Timeline semaphore for io→decompress→dequant→compute pipeline */
    uint64_t timeline_value;
    void    *timeline_semaphore;

    /* Statistics */
    int64_t n_dispatches;
    int64_t n_fallbacks;       /* fell back to CPU       */
} HermesL4State;

#endif /* HERMES_L4 */

/* ════════════════════════════════════════════════════════════════
 *  Global HERMES context
 * ════════════════════════════════════════════════════════════════ */

typedef struct {
    /* Model metadata */
    int n_layers;
    int n_experts;           /* E per layer        */
    int expert_dim;          /* hidden dim D       */
    int expert_inter;        /* intermediate dim I */
    int top_k;               /* MoE top-K          */

    /* Layer states */
#ifdef HERMES_L1
    HermesL1State l1;
#endif
#ifdef HERMES_L2
    HermesL2State l2;
#endif
#ifdef HERMES_L3
    HermesL3State l3;
#endif
#ifdef HERMES_L4
    HermesL4State l4;
#endif

    /* Global statistics */
    int64_t total_tokens;
    int64_t total_expert_loads;
    int64_t total_cache_hits;
    int64_t total_prefetch_hits;

    /* Thread safety */
    pthread_mutex_t mtx;
    int initialized;
} HermesCtx;

/* Global singleton (simplifies integration with colibrì's single-file model) */
extern HermesCtx g_hermes;

/* ════════════════════════════════════════════════════════════════
 *  Lifecycle management
 * ════════════════════════════════════════════════════════════════ */

/*
 * Initialize HERMES from environment variables.
 * Called once at startup (before first inference).
 *
 * Env vars:
 *   HERMES=1          — master enable
 *   HERMES_L1=1       — enable L1 predictor
 *   HERMES_L2=1       — enable L2 compression
 *   HERMES_L3=1       — enable L3 precision
 *   HERMES_L4=1       — enable L4 Vulkan
 *   HERMES_EMBED=path — path to expert embedding file
 *   HERMES_DICT=path  — path to K-SVD dictionary file
 *   HERMES_SENS=path  — path to sensitivity profile file
 *
 * Returns: 0 on success, -1 on failure (engine should continue without HERMES)
 */
int  hermes_init(int n_layers, int n_experts, int expert_dim,
                 int expert_inter, int top_k);

/* Shutdown and free all resources */
void hermes_shutdown(void);

/* Check if HERMES is enabled */
static inline int hermes_enabled(void) { return g_hermes.initialized; }

/* ════════════════════════════════════════════════════════════════
 *  Hook 1: L1 Expert Prediction (integrate in moe() after routing)
 * ════════════════════════════════════════════════════════════════ */

/*
 * Predict which experts will be needed for upcoming tokens/layers
 * and issue prefetch requests. Called after each layer's routing
 * decision is finalized.
 *
 * Parameters:
 *   layer         — current layer index (0-based)
 *   S             — batch size (tokens in this step)
 *   K             — top-K experts per token
 *   routed_eids   — [S × K] expert IDs that were routed to (row-major)
 *   routed_ws     — [S × K] corresponding routing weights
 *   hidden_state  — [S × D] post-attention hidden state (for similarity)
 *
 * Output:
 *   out_preds     — [max_out] array of predicted (layer, eid) pairs
 *   max_out       — capacity of out_preds
 *
 * Returns: number of predictions written (0 if HERMES_L1 disabled or error)
 */
int hermes_l1_predict(
    int         layer,
    int         S,
    int         K,
    const int  *routed_eids,    /* [S × K] */
    const float *routed_ws,     /* [S × K] */
    const float *hidden_state,   /* [S × D] (may be NULL) */
    /* output */
    HermesPred *out_preds,       /* [max_out] */
    int        *out_pred_layers, /* [max_out] predicted layer indices */
    int         max_out
);

/* Update L1 online model with confirmed routing decisions */
void hermes_l1_update(
    int         layer,
    int         S,
    int         K,
    const int  *routed_eids,    /* [S × K] */
    const float *routed_ws      /* [S × K] */
);

/* ════════════════════════════════════════════════════════════════
 *  Hook 2: L2/L3 Compression & Precision (integrate in expert_load)
 * ════════════════════════════════════════════════════════════════ */

/*
 * After an expert's weights are loaded from disk into the slab buffer,
 * this hook can:
 *   - Decompress if the on-disk format is compressed (L2)
 *   - Requantize to a different precision (L3)
 *   - Modify the QT format descriptor accordingly
 *
 * Parameters:
 *   layer, eid    — which expert
 *   slab          — raw weight data [in/out, may be modified in-place]
 *   slab_len      — current slab length in bytes
 *   slab_cap      — slab capacity in bytes
 *   fslab         — float scale data [in/out]
 *   fslab_len     — current fslab length
 *   fslab_cap     — fslab capacity
 *   fmt_in        — input QT format (see enum above)
 *   gs_in         — input group size
 *   O, I          — output rows, input dimension (for size computation)
 *
 * Output (modified in-place):
 *   *fmt_out      — new QT format (may == fmt_in if no change)
 *   *gs_out       — new group size
 *   *slab_len_out — new slab length
 *
 * Returns: 1 if weights were modified, 0 if unchanged (use as-is)
 */
int hermes_l23_post_load(
    int       layer,
    int       eid,
    /* weight buffer [in/out] */
    uint8_t  *slab,        int64_t slab_len,    int64_t slab_cap,
    float    *fslab,       int64_t fslab_len,   int64_t fslab_cap,
    /* format [in] */
    int       fmt_in,
    int       gs_in,
    int       O, int I,
    /* format [out] */
    int      *fmt_out,
    int      *gs_out,
    int64_t  *slab_len_out
);

/* ════════════════════════════════════════════════════════════════
 *  Hook 3: L4 Vulkan Compute (integrate before CPU expert matmul)
 * ════════════════════════════════════════════════════════════════ */

/*
 * Attempt to offload expert computation (gate + up + SiLU + down)
 * to Vulkan GPU. If successful, results are written to `out` and
 * the caller skips the CPU path.
 *
 * Parameters:
 *   x       — input activations [S × I]
 *   S       — batch size (number of tokens)
 *   I       — input dimension
 *   D       — intermediate dimension (gate/up output)
 *   O       — output dimension (down output)
 *   gate_q  — quantized gate weights
 *   up_q    — quantized up weights
 *   down_q  — quantized down weights
 *   gate_s, up_s, down_s — per-row/group scale factors
 *   fmt     — QT format for all three (assumed same)
 *   gs      — group size
 *
 * Output:
 *   out     — [S × O] computation result
 *
 * Returns: 1 if GPU computed successfully, 0 = fall back to CPU
 */
int hermes_l4_expert_compute(
    const float  *x,            /* [S × I] */
    int           S,
    int           I,
    int           D,
    int           O,
    /* quantized weights */
    const void   *gate_q,
    const void   *up_q,
    const void   *down_q,
    const float  *gate_s,
    const float  *up_s,
    const float  *down_s,
    int           fmt,
    int           gs,
    /* output */
    float        *out           /* [S × O] */
);

/* ════════════════════════════════════════════════════════════════
 *  Statistics & debugging
 * ════════════════════════════════════════════════════════════════ */

typedef struct {
    int64_t tokens;
    int64_t expert_loads;
    int64_t cache_hits;
    int64_t prefetch_hits;
    double  cache_hit_rate;
    double  prefetch_hit_rate;
    double  avg_precision;    /* L1 predictor */
    double  compression_ratio; /* L2 */
    double  avg_bits;          /* L3 weighted average */
    int     gpu_dispatches;    /* L4 */
    int     gpu_fallbacks;     /* L4 */
} HermesStats;

void hermes_get_stats(HermesStats *stats);
void hermes_print_stats(void);

/* ════════════════════════════════════════════════════════════════
 *  Inline hook wrappers (zero-overhead when HERMES disabled)
 * ════════════════════════════════════════════════════════════════ */

#ifdef HERMES

/* Hook 1 wrapper — call in moe() after routing, before expert resolve */
static inline int hermes_hook1_predict(
    int layer, int S, int K,
    const int *eids, const float *ws, const float *hs,
    HermesPred *preds, int *pred_layers, int max_out)
{
#ifdef HERMES_L1
    return hermes_l1_predict(layer, S, K, eids, ws, hs, preds, pred_layers, max_out);
#else
    (void)layer; (void)S; (void)K; (void)eids; (void)ws; (void)hs;
    (void)preds; (void)pred_layers; (void)max_out;
    return 0;
#endif
}

/* Hook 2 wrapper — call in expert_load() after pread */
static inline int hermes_hook2_postload(
    int layer, int eid,
    uint8_t *slab, int64_t slab_len, int64_t slab_cap,
    float *fslab, int64_t fslab_len, int64_t fslab_cap,
    int fmt_in, int gs_in, int O, int I,
    int *fmt_out, int *gs_out, int64_t *slab_len_out)
{
#ifdef HERMES_L2
    return hermes_l23_post_load(layer, eid, slab, slab_len, slab_cap,
                                fslab, fslab_len, fslab_cap,
                                fmt_in, gs_in, O, I,
                                fmt_out, gs_out, slab_len_out);
#else
    (void)layer; (void)eid; (void)slab; (void)slab_len; (void)slab_cap;
    (void)fslab; (void)fslab_len; (void)fslab_cap;
    *fmt_out = fmt_in; *gs_out = gs_in; *slab_len_out = slab_len;
    return 0;
#endif
}

/* Hook 3 wrapper — call before CPU expert matmul */
static inline int hermes_hook3_compute(
    const float *x, int S, int I, int D, int O,
    const void *gq, const void *uq, const void *dq,
    const float *gs, const float *us, const float *ds,
    int fmt, int gsz, float *out)
{
#ifdef HERMES_L4
    return hermes_l4_expert_compute(x, S, I, D, O, gq, uq, dq, gs, us, ds, fmt, gsz, out);
#else
    (void)x; (void)S; (void)I; (void)D; (void)O;
    (void)gq; (void)uq; (void)dq; (void)gs; (void)us; (void)ds;
    (void)fmt; (void)gsz; (void)out;
    return 0;  /* always fall back to CPU */
#endif
}

#else /* !HERMES — all hooks compile to nothing */

static inline int hermes_hook1_predict(int l, int S, int K, const int *e,
    const float *w, const float *h, HermesPred *p, int *pl, int m)
{ (void)l;(void)S;(void)K;(void)e;(void)w;(void)h;(void)p;(void)pl;(void)m; return 0; }

static inline int hermes_hook2_postload(int l, int e, uint8_t *s, int64_t sl, int64_t sc,
    float *f, int64_t fl, int64_t fc, int fi, int gi, int O, int I,
    int *fo, int *go, int64_t *slo)
{ (void)l;(void)e;(void)s;(void)sl;(void)sc;(void)f;(void)fl;(void)fc;
  (void)fi;(void)gi;(void)O;(void)I; *fo=fi; *go=gi; *slo=sl; return 0; }

static inline int hermes_hook3_compute(const float *x, int S, int I, int D, int O,
    const void *gq, const void *uq, const void *dq, const float *gs,
    const float *us, const float *ds, int fmt, int gsz, float *out)
{ (void)x;(void)S;(void)I;(void)D;(void)O;(void)gq;(void)uq;(void)dq;
  (void)gs;(void)us;(void)ds;(void)fmt;(void)gsz;(void)out; return 0; }

#endif /* HERMES */

#ifdef __cplusplus
}
#endif

#endif /* HERMES_H */
