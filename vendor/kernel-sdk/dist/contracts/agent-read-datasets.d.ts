/**
 * Agent Read Plane — the dataset vocabulary.
 *
 * WHY THIS FILE EXISTS: the dataset name in `POST /agent/pages/:pageLabel/
 * datasets/:dataset/query` is the one open-looking segment of the whole plane, and
 * the registry is the ONLY bridge from that name to code. A string never becomes a
 * table or column name at runtime: the name resolves here, and a field outside the
 * dataset's allowlist is a static 400 BEFORE any SQL. Declaring the vocabulary once
 * (here) and deriving the enums, the catalog response and the filter allowlists from
 * it is the same anti-drift law the claim/plane registry states in its own header.
 *
 * SCOPE: names, field maps, scalar kinds, deterministic sort keys. The SQL mapping
 * (dataset -> table, field -> expression) lands in slice A together with the
 * operation, WITH a mandatory two-way test: every available dataset's declared
 * fields are exactly covered by the runtime mapping, and vice versa. `platforms`
 * and `captureState` — the two remaining catalog-response columns — are runtime
 * facts about a deployment rather than vocabulary, and join in the same slice.
 *
 * Source: the contract appendix §17 dataset catalog (names, fields, default sorts,
 * stable keys and the money-bearing set are copied from it verbatim; the scalar
 * kinds are the appendix's own closed union). Architecture reference:
 * `investigations/agent-read-api-design-2026-07-31.md` §10.
 */
import { type AgentCapability } from "./agent-read-capabilities";
/**
 * The closed scalar union a dataset row may carry. There is no nested structure
 * and no free JSON: `components.schemas` is empty in the generated OpenAPI (every
 * schema inlines), so a recursive JSON value expands forever. A dataset that needs
 * structure needs a real operation instead.
 */
export declare const AGENT_DATASET_FIELD_KINDS: readonly ["string", "int", "mills", "bool", "timestamp", "date", "string_array"];
export type AgentDatasetFieldKind = (typeof AGENT_DATASET_FIELD_KINDS)[number];
export type AgentDatasetSort = {
    readonly field: string;
    readonly dir: "asc" | "desc";
    /** NULLS LAST on a nullable sort column, so a row with no value never leads. */
    readonly nullsLast: boolean;
};
export type AgentDatasetDefinition = {
    /**
     * Money-bearing datasets additionally require the `read:money` capability.
     *
     * A dataset carrying ANY field of kind `mills` is money-bearing by definition
     * — pinned by test, because the appendix declared one such dataset otherwise
     * and that quietly put a fan's lifetime spend behind a read:datasets-only key.
     */
    readonly moneyBearing: boolean;
    /**
     * Datasets carrying operator- or fan-written FREE TEXT additionally require
     * `read:messages`.
     *
     * `fan_notes` selects the note body verbatim, which is the same disclosure
     * class as a transcript — and the person operation puts exactly that material
     * behind `read:messages`. Without this flag a `read:datasets`-only key read the
     * notes through the dataset route instead, so the capability was a door with a
     * window next to it. Declared here rather than as a list at the handler, and
     * pinned by test against the field map, so a future dataset that adds a text
     * body cannot inherit the narrower requirement.
     */
    readonly verbatimText: boolean;
    /** Wire field -> scalar kind. This map IS the filter/sort allowlist. */
    readonly fields: Readonly<Record<string, AgentDatasetFieldKind>>;
    readonly defaultSort: AgentDatasetSort;
    /**
     * Physical row identifier(s) completing the keyset cursor `{sortValue,
     * stableKey}`. These are NOT wire fields and are never returned or filtered on;
     * they exist so pagination is total-ordered even when the sort column ties.
     * Resolved to real columns by the slice-A mapping.
     */
    readonly stableKey: readonly string[];
};
/**
 * Datasets addressable TODAY. The path enum is built from exactly these keys, so a
 * planned dataset is caught by Zod at the boundary as a static 400 — visible in the
 * catalog, not addressable in the query.
 */
export declare const AGENT_DATASETS: {
    readonly fan_memberships: {
        readonly moneyBearing: true;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly username: "string";
            readonly displayName: "string";
            readonly membershipState: "string";
            readonly firstSeenAt: "timestamp";
            readonly lastSeenAt: "timestamp";
            readonly lifetimeSpendMills: "mills";
        };
        readonly defaultSort: {
            readonly field: "lastSeenAt";
            readonly dir: "desc";
            readonly nullsLast: false;
        };
        readonly stableKey: readonly ["fanId"];
    };
    readonly dm_threads: {
        readonly moneyBearing: false;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly conversationRef: "string";
            readonly lastMessageAt: "timestamp";
            readonly messageCount: "int";
            readonly unreadCount: "int";
            readonly coverageStatus: "string";
        };
        readonly defaultSort: {
            readonly field: "lastMessageAt";
            readonly dir: "desc";
            readonly nullsLast: true;
        };
        readonly stableKey: readonly ["threadId"];
    };
    readonly subscriptions: {
        readonly moneyBearing: true;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly subscriptionRef: "string";
            readonly subscriptionState: "string";
            readonly startedAt: "timestamp";
            readonly expiresAt: "timestamp";
            readonly priceMills: "mills";
            readonly currency: "string";
        };
        readonly defaultSort: {
            readonly field: "expiresAt";
            readonly dir: "desc";
            readonly nullsLast: true;
        };
        readonly stableKey: readonly ["subscriptionId"];
    };
    readonly transactions: {
        readonly moneyBearing: true;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly transactionRef: "string";
            readonly transactionType: "string";
            readonly transactionState: "string";
            readonly occurredAt: "timestamp";
            readonly grossMills: "mills";
            readonly netMills: "mills";
            readonly feeMills: "mills";
            readonly currency: "string";
            readonly relatedMessageRef: "string";
        };
        readonly defaultSort: {
            readonly field: "occurredAt";
            readonly dir: "desc";
            readonly nullsLast: false;
        };
        readonly stableKey: readonly ["transactionId"];
    };
    readonly fan_spend_daily: {
        readonly moneyBearing: true;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly businessDate: "date";
            readonly grossMills: "mills";
            readonly netMills: "mills";
            readonly transactionCount: "int";
            readonly currency: "string";
        };
        readonly defaultSort: {
            readonly field: "businessDate";
            readonly dir: "desc";
            readonly nullsLast: false;
        };
        readonly stableKey: readonly ["fanId", "canonicalType", "transactionState"];
    };
    readonly follows: {
        readonly moneyBearing: false;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly followed: "bool";
            readonly followedAt: "timestamp";
            readonly unfollowedAt: "timestamp";
        };
        readonly defaultSort: {
            readonly field: "followedAt";
            readonly dir: "desc";
            readonly nullsLast: true;
        };
        readonly stableKey: readonly ["followId"];
    };
    readonly followers_daily: {
        readonly moneyBearing: false;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly businessDate: "date";
            readonly followersCount: "int";
        };
        readonly defaultSort: {
            readonly field: "businessDate";
            readonly dir: "desc";
            readonly nullsLast: false;
        };
        readonly stableKey: readonly ["pageId"];
    };
    readonly fan_aliases: {
        readonly moneyBearing: false;
        readonly verbatimText: false;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly aliasKind: "string";
            readonly aliasValue: "string";
            readonly firstSeenAt: "timestamp";
            readonly lastSeenAt: "timestamp";
        };
        readonly defaultSort: {
            readonly field: "lastSeenAt";
            readonly dir: "desc";
            readonly nullsLast: true;
        };
        readonly stableKey: readonly ["aliasId"];
    };
    readonly fan_notes: {
        readonly moneyBearing: false;
        readonly verbatimText: true;
        readonly fields: {
            readonly platform: "string";
            readonly platformUserId: "string";
            readonly noteRef: "string";
            readonly noteText: "string";
            readonly createdAt: "timestamp";
            readonly updatedAt: "timestamp";
        };
        readonly defaultSort: {
            readonly field: "createdAt";
            readonly dir: "desc";
            readonly nullsLast: false;
        };
        readonly stableKey: readonly ["noteId"];
    };
    readonly sync_streams: {
        readonly moneyBearing: false;
        readonly verbatimText: false;
        readonly fields: {
            readonly stream: "string";
            readonly syncStatus: "string";
            readonly cursorAt: "timestamp";
            readonly succeededAt: "timestamp";
            readonly failedAt: "timestamp";
            readonly consecutiveFailures: "int";
        };
        readonly defaultSort: {
            readonly field: "stream";
            readonly dir: "asc";
            readonly nullsLast: false;
        };
        readonly stableKey: readonly ["pageId", "stream"];
    };
};
export type AgentDataset = keyof typeof AGENT_DATASETS;
/**
 * Datasets the catalog must NAME rather than hide. The plane's whole premise is
 * that an absent answer is distinguishable from an absent capability, so a hole in
 * the data is declared, not omitted.
 *
 * `purchase_history` and `fan_earnings` were DEMOTED from available while the
 * contract was being written: `purchase_history` is a sync-stream name with no
 * serving table at all (its canonicalization produces `message.ppv_unlocked`, which
 * projects into nothing and lives only in `domain_events`, which the read plane may
 * not read), and `fan_earnings_stats` exists in the database (migration 0061) but
 * not in the Drizzle schema and is read only by raw SQL.
 */
export declare const AGENT_PLANNED_DATASETS: {
    readonly purchase_history: {};
    readonly fan_earnings: {};
    readonly posts: {};
    readonly vault_media: {};
    readonly stories: {};
    readonly notifications: {};
    readonly fan_lists: {};
    readonly subscription_tiers: {};
    readonly livestreams: {};
    readonly campaigns: {};
    readonly comments: {};
    readonly likes: {};
    readonly polls: {};
    readonly payouts: {};
    readonly chargebacks: {};
    readonly blocks: {};
};
export type AgentPlannedDataset = keyof typeof AGENT_PLANNED_DATASETS;
/** Derived. Anything that needs "which datasets are addressable" reads THIS. */
export declare const AGENT_DATASET_NAMES: readonly AgentDataset[];
/** Derived. The catalog lists these with `availability: "planned"`. */
export declare const AGENT_PLANNED_DATASET_NAMES: readonly AgentPlannedDataset[];
export declare function agentDatasetDefinition(dataset: string): AgentDatasetDefinition | undefined;
/**
 * The capabilities a key must hold to query this dataset: `read:datasets` always,
 * plus `read:money` for a money-bearing one and `read:messages` for one that
 * serves free text. Derived from the declaration, so a dataset that gains a money
 * field or a text body cannot keep the narrower requirement.
 */
export declare function agentDatasetRequiredCapabilities(dataset: AgentDataset): readonly AgentCapability[];
/**
 * The naming convention the pin test enforces: a wire field whose name ends in
 * `Text` carries free-form content someone wrote.
 *
 * A convention rather than a per-field flag because the scalar KIND cannot tell
 * `noteText` from `username` — both are `string` — and the thing that must not
 * drift is "does this dataset hand over prose", which the field name already says.
 */
export declare function agentDatasetFieldIsVerbatimText(field: string): boolean;
/** Every declared field of a dataset is filterable — the map IS the allowlist. */
export declare function agentDatasetFieldFilterable(): boolean;
/**
 * Sortable = the kind admits a deterministic order (numbers, money, instants,
 * dates), OR the field is this dataset's default sort. Free text and booleans are
 * deliberately excluded: sorting a page of transcripts by note text buys nothing
 * and costs an unindexable ORDER BY.
 */
export declare function agentDatasetFieldSortable(dataset: AgentDataset, field: string): boolean;
export type AgentDatasetFieldView = {
    readonly field: string;
    readonly kind: AgentDatasetFieldKind;
    readonly filterable: boolean;
    readonly sortable: boolean;
};
/** The catalog view of a dataset's fields, in declaration order. */
export declare function agentDatasetFields(dataset: AgentDataset): readonly AgentDatasetFieldView[];
