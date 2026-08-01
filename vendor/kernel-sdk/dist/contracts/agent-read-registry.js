/**
 * Agent Read Plane — the single source of truth for the claim/plane vocabulary.
 *
 * WHY THIS FILE EXISTS (do not "simplify" it back into prose):
 * the design spec restated the same vocabulary in a dozen places — an enum here,
 * a count there, a matrix in the appendix, a pinned number in a test. Three
 * adversarial review rounds each found real defects caused purely by those
 * restatements drifting apart (plane enum said 19 while four other sites still
 * pinned 13; six claim classes in the architecture against four in the contract
 * appendix). The vocabulary is therefore declared ONCE, here, and the enums,
 * counts and required-plane sets are DERIVED. A drift becomes a compile error
 * instead of a silent lie in a response body.
 *
 * SCOPE: this module owns the claim/plane vocabulary only. Per-operation
 * membership (which operation may speak to which fields) lands together with the
 * operations themselves and must be declared HERE when it does — hand-listing it
 * at each route is exactly the drift this file exists to prevent.
 *
 * Design reference: `investigations/agent-read-api-design-2026-07-31.md` §5.
 */
/**
 * The six claim classes. A request may declare `claim.fields`; each field maps
 * to exactly one class (pinned by test), and the conclusion is evaluated against
 * the union of the REQUIRED planes of the named fields.
 *
 * Field names are the wire names from the contract appendix §17 — not invented
 * ones. A name that does not exist on the wire makes every real claim resolve to
 * `claim_field_unobservable`, which silently reduces `absenceProvable` to a
 * constant `false`.
 */
export const AGENT_CLAIM_CLASSES = {
    messages: {
        evidentiary: ["page_dm_messages", "page_dm_threads", "observations", "sync_raw_payloads"],
        fields: {
            textPlain: { required: ["message_archive", "dm_message_archive"] },
            textHtml: { required: ["message_archive", "dm_message_archive"] },
            priceMills: { required: ["message_archive", "dm_message_archive"] },
            isOpened: { required: ["message_archive", "dm_message_archive"] },
            isNew: { required: ["message_archive", "dm_message_archive"] },
            isTip: { required: ["message_archive", "dm_message_archive"] },
            tipAmountMills: { required: ["message_archive", "dm_message_archive"] },
            tipTextPlain: { required: ["message_archive", "dm_message_archive"] },
            inReplyToRef: { required: ["message_archive", "dm_message_archive"] },
            replyMetadata: { required: ["message_archive", "dm_message_archive"] },
            mediaMetadata: { required: ["message_archive", "dm_message_archive"] },
            deletedAt: { required: ["message_archive", "dm_message_archive"] },
            conversationRef: { required: ["message_archive", "dm_message_archive"] },
            messageCount: { required: ["message_archive", "dm_message_archive"] },
            coverageStatus: { required: ["message_archive", "dm_message_archive"] },
            purchaseState: { required: ["message_archive", "dm_message_archive"] },
        },
    },
    money: {
        evidentiary: ["fan_spend_daily"],
        fields: {
            grossMills: { required: ["transactions"] },
            netMills: { required: ["transactions"] },
            feeMills: { required: ["transactions"] },
            amountMills: { required: ["transactions"] },
            currency: { required: ["transactions"] },
            transactionState: { required: ["transactions"] },
            // Refund/chargeback outcome of a transaction. Declared as its own field
            // because `transactionState` alone reads as observable while neither
            // platform's capture can actually answer "was this refunded": Fansly has
            // no refund/chargeback lane at all (FEAT-004; rows stay `posted`
            // forever), and the OF chargeback capture is not projected into any
            // agent-readable store. The per-platform truth lives in
            // AGENT_PLATFORM_CAPABILITIES, and claiming this field is what routes a
            // "no refunds happened" conclusion through that table.
            refundState: { required: ["transactions"] },
            fanEarning: { required: ["transactions"] },
            // Lifetime totals have their own rollup; reading `transactions` for a
            // window says nothing about a lifetime figure.
            lifetimeSpendMills: { required: ["fan_spend_lifetime"] },
        },
    },
    identity: {
        evidentiary: [],
        fields: {
            platformUserId: { required: ["fans"] },
            username: { required: ["fans"] },
            displayName: { required: ["fans"] },
            membershipState: { required: ["page_fans"] },
            // Aliases live in their own stores; `fans` alone cannot answer for them.
            pageAlias: { required: ["page_fans", "page_fan_aliases", "fan_username_aliases"] },
        },
    },
    subscription: {
        evidentiary: [],
        fields: {
            subscriptionState: { required: ["page_subscriptions"] },
            subscriptionPriceMills: { required: ["page_subscriptions"] },
            subscriptionExpiresAt: { required: ["page_subscriptions"] },
        },
    },
    audience: {
        evidentiary: ["daily_followers"],
        fields: {
            followed: { required: ["page_follows"] },
            presenceAt: { required: ["page_fans"] },
        },
    },
    crm: {
        evidentiary: [],
        fields: {
            // Each CRM field has a DIFFERENT authoritative store. This is the case
            // that proved class-level `required` unsound: with `required:
            // ["fan_notes"]`, a reader could satisfy the check by reading notes and
            // then assert "no profile body" without ever opening `fan_profiles`.
            noteText: { required: ["fan_notes"] },
            summaryText: { required: ["fan_summaries"] },
            profileBody: { required: ["fan_profiles"] },
            fanFlag: { required: ["fan_flags"] },
        },
    },
};
export const AGENT_CLAIM_CLASS_NAMES = Object.keys(AGENT_CLAIM_CLASSES);
function classFieldEntries(claimClass) {
    return Object.entries(AGENT_CLAIM_CLASSES[claimClass].fields);
}
/** Every plane name, deduped, in declaration order. Derived — never hand-listed. */
export const AGENT_PLANE_NAMES = (() => {
    const seen = new Set();
    const ordered = [];
    const push = (plane) => {
        if (!seen.has(plane)) {
            seen.add(plane);
            ordered.push(plane);
        }
    };
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
        for (const [, def] of classFieldEntries(name)) {
            for (const plane of def.required) {
                push(plane);
            }
        }
        for (const plane of AGENT_CLAIM_CLASSES[name].evidentiary) {
            push(plane);
        }
    }
    return ordered;
})();
/** Derived count. Anything that needs "how many planes" reads THIS, never a literal. */
export const AGENT_PLANE_COUNT = AGENT_PLANE_NAMES.length;
/** Every declared claim field, deduped. Derived. */
export const AGENT_CLAIM_FIELDS = (() => {
    const seen = new Set();
    const ordered = [];
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
        for (const [field] of classFieldEntries(name)) {
            if (!seen.has(field)) {
                seen.add(field);
                ordered.push(field);
            }
        }
    }
    return ordered;
})();
/** field -> class. Built once; the test pins that no field lands in two classes. */
export const AGENT_CLAIM_FIELD_CLASS = (() => {
    const map = new Map();
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
        for (const [field] of classFieldEntries(name)) {
            const key = field;
            if (!map.has(key)) {
                map.set(key, name);
            }
        }
    }
    return map;
})();
/**
 * Widened view of a class: its evidentiary planes, and the union of the required
 * planes of all its fields.
 *
 * `as const` narrows each array to a literal tuple, which makes `.includes(x)`
 * on a plain `string` a type error. Callers want set membership, so the widening
 * happens once here rather than as casts scattered at every use.
 */
export function agentClassPlanes(claimClass) {
    const required = new Set();
    const fields = [];
    for (const [field, def] of classFieldEntries(claimClass)) {
        fields.push(field);
        for (const plane of def.required) {
            required.add(plane);
        }
    }
    return {
        required: [...required],
        evidentiary: AGENT_CLAIM_CLASSES[claimClass].evidentiary,
        fields,
    };
}
/** plane -> role within a given class. Used to build `capture.planes[]`. */
export function agentPlaneRole(claimClass, plane) {
    const { required, evidentiary } = agentClassPlanes(claimClass);
    if (required.includes(plane)) {
        return "required";
    }
    if (evidentiary.includes(plane)) {
        return "evidentiary";
    }
    return "not_applicable";
}
/**
 * Boundary lookup: accepts an UNVALIDATED field name (it arrives from a request)
 * and resolves its class, or `undefined` when the field is unknown. The map
 * itself stays keyed by the literal union so typed callers keep the compile-time
 * guarantee; only this seam widens.
 */
export function agentClaimFieldClass(field) {
    return AGENT_CLAIM_FIELD_CLASS.get(field);
}
/**
 * The planes that must be `read` before a negative conclusion is permitted for
 * these claim fields — the union of each named field's authoritative stores.
 *
 * Returns `null` (fail closed) when any field is unknown, or when the claim is
 * empty: callers treat `null` as "cannot conclude".
 */
export function requiredPlanesForClaimFields(fields) {
    // An empty claim is epistemically identical to no claim at all: "every
    // required plane was read" is vacuously true over an empty set, which would
    // authorise a negative conclusion nothing was actually read for. The spec
    // (§5.4) says a missing claim yields `absenceProvable: false`; an empty one
    // must take the same branch rather than a different, permissive one.
    if (fields.length === 0) {
        return null;
    }
    const planes = new Set();
    for (const field of fields) {
        const claimClass = agentClaimFieldClass(field);
        if (!claimClass) {
            return null;
        }
        const classFields = AGENT_CLAIM_CLASSES[claimClass].fields;
        const def = classFields[field];
        if (!def) {
            return null;
        }
        for (const plane of def.required) {
            planes.add(plane);
        }
    }
    return [...planes];
}
