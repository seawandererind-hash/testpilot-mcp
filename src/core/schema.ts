import * as z from 'zod/v4';

export const CONFIG_SCHEMA_VERSION = 1;
export const STATE_SCHEMA_VERSION = 1;

export const APP_TYPES = ['web', 'android', 'ios', 'android-ios', 'windows', 'macos', 'electron', 'api', 'hybrid'] as const;
export type AppType = (typeof APP_TYPES)[number];

export const PATTERNS = ['pom', 'bdd', 'screenplay', 'keyword', 'hybrid'] as const;
export type Pattern = (typeof PATTERNS)[number];

export const EXECUTION_TARGETS = ['local', 'grid', 'browserstack', 'saucelabs', 'lambdatest', 'docker'] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

export const TEST_CASE_SOURCES = ['jira', 'xray', 'zephyr', 'browserstack', 'testrail', 'azure-devops', 'qtest', 'excel', 'csv', 'word', 'markdown', 'gherkin', 'none'] as const;
export type TestCaseSource = (typeof TEST_CASE_SOURCES)[number];

export const CI_PROVIDERS = ['github-actions', 'azure-devops', 'gitlab', 'jenkins', 'none'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

export const APP_KINDS = ['url', 'apk', 'aab', 'ipa', 'app', 'exe', 'cloud-id', 'package-id', 'bundle-id', 'electron-path', 'openapi'] as const;
export type AppKind = (typeof APP_KINDS)[number];

export const ConfigSchema = z.object({
    schemaVersion: z.number().int().default(CONFIG_SCHEMA_VERSION),
    project: z
        .object({
            name: z.string().optional(),
            testRoot: z.string().default('.')
        })
        .default({ testRoot: '.' }),
    appType: z.enum(APP_TYPES).optional(),
    existing: z
        .object({
            mode: z.enum(['create', 'extend']),
            framework: z.string().optional()
        })
        .optional(),
    stack: z
        .object({
            framework: z.string().optional(),
            language: z.string().optional(),
            buildTool: z.string().optional(),
            pattern: z.enum(PATTERNS).optional(),
            templatePack: z.string().optional()
        })
        .default({}),
    execution: z
        .object({
            target: z.enum(EXECUTION_TARGETS).optional(),
            browsers: z.array(z.string()).optional(),
            devices: z.array(z.string()).optional()
        })
        .default({}),
    integrations: z
        .object({
            testCaseSource: z.enum(TEST_CASE_SOURCES).optional(),
            defectTracker: z.string().optional(),
            ci: z.enum(CI_PROVIDERS).optional(),
            reporting: z.array(z.string()).optional()
        })
        .default({}),
    app: z
        .object({
            kind: z.enum(APP_KINDS).optional(),
            ref: z.string().optional(),
            notes: z.string().optional()
        })
        .default({}),
    extras: z.array(z.string()).default([]),
    environments: z
        .array(
            z.object({
                name: z.string(),
                baseUrlEnv: z.string().optional(),
                isProduction: z.boolean().default(false)
            })
        )
        .default([]),
    orgPreset: z.string().optional()
});
export type Config = z.infer<typeof ConfigSchema>;

export const ApprovalSchema = z.object({
    what: z.string(),
    by: z.string(),
    at: z.string(),
    note: z.string().optional()
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const PendingConfirmationSchema = z.object({
    token: z.string(),
    action: z.string(),
    digest: z.string(),
    createdAt: z.string(),
    expiresAt: z.string()
});
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;

export const StateSchema = z.object({
    schemaVersion: z.number().int().default(STATE_SCHEMA_VERSION),
    step: z.string().default('APP_TYPE'),
    completed: z.array(z.string()).default([]),
    skipped: z.array(z.string()).default([]),
    answers: z.record(z.string(), z.unknown()).default({}),
    approvals: z.array(ApprovalSchema).default([]),
    pending: z.record(z.string(), PendingConfirmationSchema).default({}),
    lastRun: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional()
});
export type State = z.infer<typeof StateSchema>;

/** A test case in TestPilot's common shape, whatever its source. */
export const TestStepSchema = z.object({
    action: z.string(),
    data: z.string().optional(),
    expected: z.string().optional()
});
export type TestStep = z.infer<typeof TestStepSchema>;

export const VERDICTS = ['AUTOMATE', 'MANUAL', 'NEEDS-REWORK'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const TestCaseSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    priority: z.string().optional(),
    area: z.string().optional(),
    preconditions: z.array(z.string()).default([]),
    steps: z.array(TestStepSchema).default([]),
    expected: z.string().optional(),
    testData: z.string().optional(),
    tags: z.array(z.string()).default([]),
    source: z.object({
        type: z.string(),
        ref: z.string().optional(),
        link: z.string().optional(),
        importedAt: z.string()
    }),
    review: z
        .object({
            score: z.number(),
            verdict: z.enum(VERDICTS),
            scores: z.record(z.string(), z.number()),
            issues: z.array(z.string()),
            suggestions: z.array(z.string()),
            duplicateOf: z.array(z.string()).default([]),
            reviewedAt: z.string()
        })
        .optional(),
    automation: z
        .object({
            wave: z.number().int().optional(),
            effort: z.enum(['S', 'M', 'L']).optional(),
            status: z.enum(['planned', 'generated', 'passing', 'failing', 'manual']).optional(),
            specFile: z.string().optional()
        })
        .optional()
});
export type TestCase = z.infer<typeof TestCaseSchema>;
