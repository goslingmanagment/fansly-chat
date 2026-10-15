import { z } from "zod";
/** The screens the browser's login desk knows (spec §7); `unknown`: none of
 *  them — the owner opens the screen. */
export declare const pageBrowserLoginScreenSchema: z.ZodEnum<{
    unknown: "unknown";
    success: "success";
    error: "error";
    code: "code";
    login: "login";
}>;
export type PageBrowserLoginScreen = z.infer<typeof pageBrowserLoginScreenSchema>;
export declare const pageBrowserLoginFieldSchema: z.ZodEnum<{
    code: "code";
    login: "login";
    password: "password";
}>;
/** What the browser shows now. */
export declare const pageBrowserScreenSchema: z.ZodObject<{
    screen: z.ZodEnum<{
        unknown: "unknown";
        success: "success";
        error: "error";
        code: "code";
        login: "login";
    }>;
    screenVersion: z.ZodString;
    fields: z.ZodArray<z.ZodEnum<{
        code: "code";
        login: "login";
        password: "password";
    }>>;
    siteError: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** Why the browser did not do what was asked: not in the manual login (yet,
 *  or any more), the screen is another one now, a step is under way, the
 *  browser refused Hub's token. */
export declare const pageBrowserLoginRefusalSchema: z.ZodEnum<{
    not_manual_login: "not_manual_login";
    screen_changed: "screen_changed";
    busy: "busy";
    token: "token";
}>;
/** The login of the page's browser: closed, open, closing (the engine
 *  brings the automation back). */
export declare const pageBrowserLoginStateSchema: z.ZodEnum<{
    off: "off";
    wanted: "wanted";
    ending: "ending";
}>;
export declare const pageBrowserLoginResponseSchema: z.ZodObject<{
    page: z.ZodObject<{
        label: z.ZodString;
        pageId: z.ZodNumber;
    }, z.core.$strict>;
    transport: z.ZodEnum<{
        node: "node";
        browser: "browser";
    }>;
    login: z.ZodObject<{
        state: z.ZodEnum<{
            off: "off";
            wanted: "wanted";
            ending: "ending";
        }>;
        changedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>;
    browser: z.ZodObject<{
        ready: z.ZodBoolean;
        problem: z.ZodNullable<z.ZodString>;
        reachable: z.ZodNullable<z.ZodBoolean>;
    }, z.core.$strict>;
    screen: z.ZodNullable<z.ZodObject<{
        screen: z.ZodEnum<{
            unknown: "unknown";
            success: "success";
            error: "error";
            code: "code";
            login: "login";
        }>;
        screenVersion: z.ZodString;
        fields: z.ZodArray<z.ZodEnum<{
            code: "code";
            login: "login";
            password: "password";
        }>>;
        siteError: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    refused: z.ZodNullable<z.ZodEnum<{
        not_manual_login: "not_manual_login";
        screen_changed: "screen_changed";
        busy: "busy";
        token: "token";
    }>>;
    screenUrl: z.ZodString;
}, z.core.$strict>;
export type PageBrowserLoginResponse = z.infer<typeof pageBrowserLoginResponseSchema>;
/** The answer to a step: the screen after it, or why it was not done. */
export declare const pageBrowserLoginStepResponseSchema: z.ZodObject<{
    screen: z.ZodNullable<z.ZodObject<{
        screen: z.ZodEnum<{
            unknown: "unknown";
            success: "success";
            error: "error";
            code: "code";
            login: "login";
        }>;
        screenVersion: z.ZodString;
        fields: z.ZodArray<z.ZodEnum<{
            code: "code";
            login: "login";
            password: "password";
        }>>;
        siteError: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    refused: z.ZodNullable<z.ZodEnum<{
        not_manual_login: "not_manual_login";
        screen_changed: "screen_changed";
        busy: "busy";
        token: "token";
    }>>;
    unreachable: z.ZodBoolean;
}, z.core.$strict>;
export type PageBrowserLoginStepResponse = z.infer<typeof pageBrowserLoginStepResponseSchema>;
export declare const pageBrowserLoginChangeResponseSchema: z.ZodObject<{
    state: z.ZodEnum<{
        off: "off";
        wanted: "wanted";
        ending: "ending";
    }>;
    changed: z.ZodBoolean;
}, z.core.$strict>;
export type PageBrowserLoginChangeResponse = z.infer<typeof pageBrowserLoginChangeResponseSchema>;
export declare const pageBrowserLoginSubmitBodySchema: z.ZodObject<{
    login: z.ZodString;
    password: z.ZodString;
}, z.core.$strict>;
export type PageBrowserLoginSubmitBody = z.infer<typeof pageBrowserLoginSubmitBodySchema>;
export declare const pageBrowserLoginCodeBodySchema: z.ZodObject<{
    code: z.ZodString;
}, z.core.$strict>;
export type PageBrowserLoginCodeBody = z.infer<typeof pageBrowserLoginCodeBodySchema>;
/** The onboarding of a profile no page has: off, the owner's login, open
 *  (the login closed, the account checked on request), closing (given up). */
export declare const pageBrowserOnboardingStateSchema: z.ZodEnum<{
    off: "off";
    login: "login";
    open: "open";
    closing: "closing";
}>;
export type PageBrowserOnboardingState = z.infer<typeof pageBrowserOnboardingStateSchema>;
/** What the profile's operator last said of itself, as Hub recorded it. */
export declare const pageBrowserOperatorViewSchema: z.ZodObject<{
    step: z.ZodNullable<z.ZodString>;
    stopReason: z.ZodNullable<z.ZodString>;
    mode: z.ZodEnum<{
        automation: "automation";
        manual_login: "manual_login";
    }>;
    exitOpen: z.ZodBoolean;
    exitIp: z.ZodNullable<z.ZodString>;
    accountId: z.ZodNullable<z.ZodString>;
    sessionKnown: z.ZodBoolean;
    selfTest: z.ZodNullable<z.ZodObject<{
        ok: z.ZodBoolean;
        at: z.ZodISODateTime;
        failed: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    lastStateAt: z.ZodNullable<z.ZodISODateTime>;
    linkError: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** The account the browser's live session belongs to, as the engine read it
 *  through the browser (`GET /account/me`), or why there is none. */
export declare const pageBrowserIdentitySchema: z.ZodObject<{
    requestedAt: z.ZodNullable<z.ZodISODateTime>;
    pending: z.ZodBoolean;
    ok: z.ZodNullable<z.ZodBoolean>;
    accountId: z.ZodNullable<z.ZodString>;
    username: z.ZodNullable<z.ZodString>;
    displayName: z.ZodNullable<z.ZodString>;
    checkedAt: z.ZodNullable<z.ZodISODateTime>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const pageBrowserProfileSummarySchema: z.ZodObject<{
    profileId: z.ZodString;
    name: z.ZodString;
    container: z.ZodString;
    onboarding: z.ZodEnum<{
        off: "off";
        login: "login";
        open: "open";
        closing: "closing";
    }>;
    createdAt: z.ZodISODateTime;
    proxySet: z.ZodBoolean;
    pinnedExitIp: z.ZodNullable<z.ZodString>;
    envSet: z.ZodBoolean;
    operator: z.ZodObject<{
        step: z.ZodNullable<z.ZodString>;
        stopReason: z.ZodNullable<z.ZodString>;
        mode: z.ZodEnum<{
            automation: "automation";
            manual_login: "manual_login";
        }>;
        exitOpen: z.ZodBoolean;
        exitIp: z.ZodNullable<z.ZodString>;
        accountId: z.ZodNullable<z.ZodString>;
        sessionKnown: z.ZodBoolean;
        selfTest: z.ZodNullable<z.ZodObject<{
            ok: z.ZodBoolean;
            at: z.ZodISODateTime;
            failed: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        lastStateAt: z.ZodNullable<z.ZodISODateTime>;
        linkError: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type PageBrowserProfileSummary = z.infer<typeof pageBrowserProfileSummarySchema>;
export declare const pageBrowserProfilesResponseSchema: z.ZodObject<{
    profiles: z.ZodArray<z.ZodObject<{
        profileId: z.ZodString;
        name: z.ZodString;
        container: z.ZodString;
        onboarding: z.ZodEnum<{
            off: "off";
            login: "login";
            open: "open";
            closing: "closing";
        }>;
        createdAt: z.ZodISODateTime;
        proxySet: z.ZodBoolean;
        pinnedExitIp: z.ZodNullable<z.ZodString>;
        envSet: z.ZodBoolean;
        operator: z.ZodObject<{
            step: z.ZodNullable<z.ZodString>;
            stopReason: z.ZodNullable<z.ZodString>;
            mode: z.ZodEnum<{
                automation: "automation";
                manual_login: "manual_login";
            }>;
            exitOpen: z.ZodBoolean;
            exitIp: z.ZodNullable<z.ZodString>;
            accountId: z.ZodNullable<z.ZodString>;
            sessionKnown: z.ZodBoolean;
            selfTest: z.ZodNullable<z.ZodObject<{
                ok: z.ZodBoolean;
                at: z.ZodISODateTime;
                failed: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
            lastStateAt: z.ZodNullable<z.ZodISODateTime>;
            linkError: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type PageBrowserProfilesResponse = z.infer<typeof pageBrowserProfilesResponseSchema>;
export declare const pageBrowserProfileResponseSchema: z.ZodObject<{
    profile: z.ZodObject<{
        profileId: z.ZodString;
        name: z.ZodString;
        container: z.ZodString;
        onboarding: z.ZodEnum<{
            off: "off";
            login: "login";
            open: "open";
            closing: "closing";
        }>;
        createdAt: z.ZodISODateTime;
        proxySet: z.ZodBoolean;
        pinnedExitIp: z.ZodNullable<z.ZodString>;
        envSet: z.ZodBoolean;
        operator: z.ZodObject<{
            step: z.ZodNullable<z.ZodString>;
            stopReason: z.ZodNullable<z.ZodString>;
            mode: z.ZodEnum<{
                automation: "automation";
                manual_login: "manual_login";
            }>;
            exitOpen: z.ZodBoolean;
            exitIp: z.ZodNullable<z.ZodString>;
            accountId: z.ZodNullable<z.ZodString>;
            sessionKnown: z.ZodBoolean;
            selfTest: z.ZodNullable<z.ZodObject<{
                ok: z.ZodBoolean;
                at: z.ZodISODateTime;
                failed: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
            lastStateAt: z.ZodNullable<z.ZodISODateTime>;
            linkError: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    socksEndpoint: z.ZodNullable<z.ZodString>;
    proxy: z.ZodNullable<z.ZodObject<{
        url: z.ZodString;
        username: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    env: z.ZodNullable<z.ZodObject<{
        timeZone: z.ZodString;
        languages: z.ZodArray<z.ZodString>;
        geolocation: z.ZodObject<{
            latitude: z.ZodNumber;
            longitude: z.ZodNumber;
            accuracyM: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    login: z.ZodObject<{
        state: z.ZodEnum<{
            off: "off";
            login: "login";
            open: "open";
            closing: "closing";
        }>;
        changedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>;
    browser: z.ZodObject<{
        ready: z.ZodBoolean;
        problem: z.ZodNullable<z.ZodString>;
        reachable: z.ZodNullable<z.ZodBoolean>;
    }, z.core.$strict>;
    screen: z.ZodNullable<z.ZodObject<{
        screen: z.ZodEnum<{
            unknown: "unknown";
            success: "success";
            error: "error";
            code: "code";
            login: "login";
        }>;
        screenVersion: z.ZodString;
        fields: z.ZodArray<z.ZodEnum<{
            code: "code";
            login: "login";
            password: "password";
        }>>;
        siteError: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    refused: z.ZodNullable<z.ZodEnum<{
        not_manual_login: "not_manual_login";
        screen_changed: "screen_changed";
        busy: "busy";
        token: "token";
    }>>;
    screenUrl: z.ZodString;
    identity: z.ZodObject<{
        requestedAt: z.ZodNullable<z.ZodISODateTime>;
        pending: z.ZodBoolean;
        ok: z.ZodNullable<z.ZodBoolean>;
        accountId: z.ZodNullable<z.ZodString>;
        username: z.ZodNullable<z.ZodString>;
        displayName: z.ZodNullable<z.ZodString>;
        checkedAt: z.ZodNullable<z.ZodISODateTime>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type PageBrowserProfileResponse = z.infer<typeof pageBrowserProfileResponseSchema>;
export declare const pageBrowserProfileProxyBodySchema: z.ZodObject<{
    proxy: z.ZodObject<{
        url: z.ZodString;
        username: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        password: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type PageBrowserProfileProxyBody = z.infer<typeof pageBrowserProfileProxyBodySchema>;
/** The proxy saved: the exit IP Hub saw through it (`api.ipify.org`), for
 *  the owner to pin. */
export declare const pageBrowserProfileProxyResponseSchema: z.ZodObject<{
    exitIp: z.ZodString;
}, z.core.$strict>;
export declare const pageBrowserProfilePinBodySchema: z.ZodObject<{
    ip: z.ZodString;
}, z.core.$strict>;
export declare const pageBrowserProfilePinResponseSchema: z.ZodObject<{
    pinnedExitIp: z.ZodString;
}, z.core.$strict>;
export declare const pageBrowserProfileChangeResponseSchema: z.ZodObject<{
    state: z.ZodEnum<{
        off: "off";
        login: "login";
        open: "open";
        closing: "closing";
    }>;
    changed: z.ZodBoolean;
}, z.core.$strict>;
export type PageBrowserProfileChangeResponse = z.infer<typeof pageBrowserProfileChangeResponseSchema>;
export declare const pageBrowserRouteSchemas: {
    readonly pageBrowserLoginGet: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Read the login of a page's server browser: its state, whether the browser is ready, the screen it shows now";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                page: z.ZodObject<{
                    label: z.ZodString;
                    pageId: z.ZodNumber;
                }, z.core.$strict>;
                transport: z.ZodEnum<{
                    node: "node";
                    browser: "browser";
                }>;
                login: z.ZodObject<{
                    state: z.ZodEnum<{
                        off: "off";
                        wanted: "wanted";
                        ending: "ending";
                    }>;
                    changedAt: z.ZodNullable<z.ZodISODateTime>;
                }, z.core.$strict>;
                browser: z.ZodObject<{
                    ready: z.ZodBoolean;
                    problem: z.ZodNullable<z.ZodString>;
                    reachable: z.ZodNullable<z.ZodBoolean>;
                }, z.core.$strict>;
                screen: z.ZodNullable<z.ZodObject<{
                    screen: z.ZodEnum<{
                        unknown: "unknown";
                        success: "success";
                        error: "error";
                        code: "code";
                        login: "login";
                    }>;
                    screenVersion: z.ZodString;
                    fields: z.ZodArray<z.ZodEnum<{
                        code: "code";
                        login: "login";
                        password: "password";
                    }>>;
                    siteError: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                refused: z.ZodNullable<z.ZodEnum<{
                    not_manual_login: "not_manual_login";
                    screen_changed: "screen_changed";
                    busy: "busy";
                    token: "token";
                }>>;
                screenUrl: z.ZodString;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserLoginStart: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Open the login of a page's server browser: the page pauses, the engine puts the browser into the manual login";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                state: z.ZodEnum<{
                    off: "off";
                    wanted: "wanted";
                    ending: "ending";
                }>;
                changed: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserLoginFinish: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Close the login of a page's server browser: the engine checks the browser and brings the automation back";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                state: z.ZodEnum<{
                    off: "off";
                    wanted: "wanted";
                    ending: "ending";
                }>;
                changed: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserLoginSubmit: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Type the login and the password into the site's login form in the page's server browser and press its button";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
        }, z.core.$strict>;
        readonly body: z.ZodObject<{
            login: z.ZodString;
            password: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                screen: z.ZodNullable<z.ZodObject<{
                    screen: z.ZodEnum<{
                        unknown: "unknown";
                        success: "success";
                        error: "error";
                        code: "code";
                        login: "login";
                    }>;
                    screenVersion: z.ZodString;
                    fields: z.ZodArray<z.ZodEnum<{
                        code: "code";
                        login: "login";
                        password: "password";
                    }>>;
                    siteError: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                refused: z.ZodNullable<z.ZodEnum<{
                    not_manual_login: "not_manual_login";
                    screen_changed: "screen_changed";
                    busy: "busy";
                    token: "token";
                }>>;
                unreachable: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserLoginCode: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Type the 2FA code into the site's code form in the page's server browser and press its button";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
        }, z.core.$strict>;
        readonly body: z.ZodObject<{
            code: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                screen: z.ZodNullable<z.ZodObject<{
                    screen: z.ZodEnum<{
                        unknown: "unknown";
                        success: "success";
                        error: "error";
                        code: "code";
                        login: "login";
                    }>;
                    screenVersion: z.ZodString;
                    fields: z.ZodArray<z.ZodEnum<{
                        code: "code";
                        login: "login";
                        password: "password";
                    }>>;
                    siteError: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                refused: z.ZodNullable<z.ZodEnum<{
                    not_manual_login: "not_manual_login";
                    screen_changed: "screen_changed";
                    busy: "busy";
                    token: "token";
                }>>;
                unreachable: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserLoginScreenshot: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Binary image/jpeg — the page's server browser as it shows now, while its login is open (kept nowhere)";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodString;
        };
    };
    readonly pageBrowserProfiles: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "The page browsers' profiles no page has yet (made by add-profile): their onboarding, proxy, pin, the browser's last word";
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                profiles: z.ZodArray<z.ZodObject<{
                    profileId: z.ZodString;
                    name: z.ZodString;
                    container: z.ZodString;
                    onboarding: z.ZodEnum<{
                        off: "off";
                        login: "login";
                        open: "open";
                        closing: "closing";
                    }>;
                    createdAt: z.ZodISODateTime;
                    proxySet: z.ZodBoolean;
                    pinnedExitIp: z.ZodNullable<z.ZodString>;
                    envSet: z.ZodBoolean;
                    operator: z.ZodObject<{
                        step: z.ZodNullable<z.ZodString>;
                        stopReason: z.ZodNullable<z.ZodString>;
                        mode: z.ZodEnum<{
                            automation: "automation";
                            manual_login: "manual_login";
                        }>;
                        exitOpen: z.ZodBoolean;
                        exitIp: z.ZodNullable<z.ZodString>;
                        accountId: z.ZodNullable<z.ZodString>;
                        sessionKnown: z.ZodBoolean;
                        selfTest: z.ZodNullable<z.ZodObject<{
                            ok: z.ZodBoolean;
                            at: z.ZodISODateTime;
                            failed: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        lastStateAt: z.ZodNullable<z.ZodISODateTime>;
                        linkError: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                }, z.core.$strict>>;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileGet: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Read a new page's onboarding through its browser: the profile, its proxy and pin, the login and the screen it shows, the account check";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                profile: z.ZodObject<{
                    profileId: z.ZodString;
                    name: z.ZodString;
                    container: z.ZodString;
                    onboarding: z.ZodEnum<{
                        off: "off";
                        login: "login";
                        open: "open";
                        closing: "closing";
                    }>;
                    createdAt: z.ZodISODateTime;
                    proxySet: z.ZodBoolean;
                    pinnedExitIp: z.ZodNullable<z.ZodString>;
                    envSet: z.ZodBoolean;
                    operator: z.ZodObject<{
                        step: z.ZodNullable<z.ZodString>;
                        stopReason: z.ZodNullable<z.ZodString>;
                        mode: z.ZodEnum<{
                            automation: "automation";
                            manual_login: "manual_login";
                        }>;
                        exitOpen: z.ZodBoolean;
                        exitIp: z.ZodNullable<z.ZodString>;
                        accountId: z.ZodNullable<z.ZodString>;
                        sessionKnown: z.ZodBoolean;
                        selfTest: z.ZodNullable<z.ZodObject<{
                            ok: z.ZodBoolean;
                            at: z.ZodISODateTime;
                            failed: z.ZodNullable<z.ZodString>;
                        }, z.core.$strict>>;
                        lastStateAt: z.ZodNullable<z.ZodISODateTime>;
                        linkError: z.ZodNullable<z.ZodString>;
                    }, z.core.$strict>;
                }, z.core.$strict>;
                socksEndpoint: z.ZodNullable<z.ZodString>;
                proxy: z.ZodNullable<z.ZodObject<{
                    url: z.ZodString;
                    username: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                env: z.ZodNullable<z.ZodObject<{
                    timeZone: z.ZodString;
                    languages: z.ZodArray<z.ZodString>;
                    geolocation: z.ZodObject<{
                        latitude: z.ZodNumber;
                        longitude: z.ZodNumber;
                        accuracyM: z.ZodNumber;
                    }, z.core.$strict>;
                }, z.core.$strict>>;
                login: z.ZodObject<{
                    state: z.ZodEnum<{
                        off: "off";
                        login: "login";
                        open: "open";
                        closing: "closing";
                    }>;
                    changedAt: z.ZodNullable<z.ZodISODateTime>;
                }, z.core.$strict>;
                browser: z.ZodObject<{
                    ready: z.ZodBoolean;
                    problem: z.ZodNullable<z.ZodString>;
                    reachable: z.ZodNullable<z.ZodBoolean>;
                }, z.core.$strict>;
                screen: z.ZodNullable<z.ZodObject<{
                    screen: z.ZodEnum<{
                        unknown: "unknown";
                        success: "success";
                        error: "error";
                        code: "code";
                        login: "login";
                    }>;
                    screenVersion: z.ZodString;
                    fields: z.ZodArray<z.ZodEnum<{
                        code: "code";
                        login: "login";
                        password: "password";
                    }>>;
                    siteError: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                refused: z.ZodNullable<z.ZodEnum<{
                    not_manual_login: "not_manual_login";
                    screen_changed: "screen_changed";
                    busy: "busy";
                    token: "token";
                }>>;
                screenUrl: z.ZodString;
                identity: z.ZodObject<{
                    requestedAt: z.ZodNullable<z.ZodISODateTime>;
                    pending: z.ZodBoolean;
                    ok: z.ZodNullable<z.ZodBoolean>;
                    accountId: z.ZodNullable<z.ZodString>;
                    username: z.ZodNullable<z.ZodString>;
                    displayName: z.ZodNullable<z.ZodString>;
                    checkedAt: z.ZodNullable<z.ZodISODateTime>;
                    error: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileProxy: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Give the proxy of the page to be (the SOCKS5 its browser's container admits): saved sealed, and its exit IP read through it";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly body: z.ZodObject<{
            proxy: z.ZodObject<{
                url: z.ZodString;
                username: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                password: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                exitIp: z.ZodString;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfilePin: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Pin the exit IP the new page's browser may open its exit through (it checks it itself before it opens)";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly body: z.ZodObject<{
            ip: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                pinnedExitIp: z.ZodString;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileLoginStart: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Open the owner's login of a new page's browser: the engine puts it into the manual login and starts it";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                state: z.ZodEnum<{
                    off: "off";
                    login: "login";
                    open: "open";
                    closing: "closing";
                }>;
                changed: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileLoginFinish: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Close the owner's login of a new page's browser: the automation back, the account can be checked through it";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                state: z.ZodEnum<{
                    off: "off";
                    login: "login";
                    open: "open";
                    closing: "closing";
                }>;
                changed: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileLoginSubmit: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Type the login and the password into the site's login form in a new page's browser and press its button";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly body: z.ZodObject<{
            login: z.ZodString;
            password: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                screen: z.ZodNullable<z.ZodObject<{
                    screen: z.ZodEnum<{
                        unknown: "unknown";
                        success: "success";
                        error: "error";
                        code: "code";
                        login: "login";
                    }>;
                    screenVersion: z.ZodString;
                    fields: z.ZodArray<z.ZodEnum<{
                        code: "code";
                        login: "login";
                        password: "password";
                    }>>;
                    siteError: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                refused: z.ZodNullable<z.ZodEnum<{
                    not_manual_login: "not_manual_login";
                    screen_changed: "screen_changed";
                    busy: "busy";
                    token: "token";
                }>>;
                unreachable: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileLoginCode: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Type the 2FA code into the site's code form in a new page's browser and press its button";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly body: z.ZodObject<{
            code: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                screen: z.ZodNullable<z.ZodObject<{
                    screen: z.ZodEnum<{
                        unknown: "unknown";
                        success: "success";
                        error: "error";
                        code: "code";
                        login: "login";
                    }>;
                    screenVersion: z.ZodString;
                    fields: z.ZodArray<z.ZodEnum<{
                        code: "code";
                        login: "login";
                        password: "password";
                    }>>;
                    siteError: z.ZodNullable<z.ZodString>;
                }, z.core.$strict>>;
                refused: z.ZodNullable<z.ZodEnum<{
                    not_manual_login: "not_manual_login";
                    screen_changed: "screen_changed";
                    busy: "busy";
                    token: "token";
                }>>;
                unreachable: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileLoginScreenshot: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Binary image/jpeg — a new page's browser as it shows now, while its login is open (kept nowhere)";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodString;
        };
    };
    readonly pageBrowserProfileClose: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "Give a new page's onboarding up: the engine stops its browser (the profile kept, unbound; remove-profile deletes it)";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 400: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 401: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 403: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 404: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 409: z.ZodObject<{
                error: z.ZodString;
                message: z.ZodString;
                statusCode: z.ZodNumber;
                reason: z.ZodOptional<z.ZodString>;
                statusUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            readonly 200: z.ZodObject<{
                state: z.ZodEnum<{
                    off: "off";
                    login: "login";
                    open: "open";
                    closing: "closing";
                }>;
                changed: z.ZodBoolean;
            }, z.core.$strict>;
        };
    };
    readonly pageBrowserProfileScreen: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "A new page's browser screen (KasmVNC web client and its WebSocket), passed through with the profile's own screen password";
        readonly params: z.ZodObject<{
            profileId: z.ZodString;
            "*": z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 200: z.ZodUnknown;
            readonly 400: z.ZodUnknown;
            readonly 401: z.ZodUnknown;
            readonly 403: z.ZodUnknown;
            readonly 404: z.ZodUnknown;
            readonly 502: z.ZodUnknown;
        };
    };
    readonly pageBrowserScreen: {
        readonly auth: {
            readonly kind: "owner-session";
        };
        readonly tags: readonly ["admin"];
        readonly summary: "The page's server browser screen (KasmVNC web client and its WebSocket), passed through with the page's own screen password";
        readonly params: z.ZodObject<{
            pageLabel: z.ZodString;
            "*": z.ZodString;
        }, z.core.$strict>;
        readonly response: {
            readonly 200: z.ZodUnknown;
            readonly 400: z.ZodUnknown;
            readonly 401: z.ZodUnknown;
            readonly 403: z.ZodUnknown;
            readonly 404: z.ZodUnknown;
            readonly 502: z.ZodUnknown;
        };
    };
};
