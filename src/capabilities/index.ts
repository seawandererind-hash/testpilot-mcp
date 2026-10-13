import { createHash } from 'node:crypto';

import { digestOf } from '../core/confirm.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { planCiSpeed } from './ci-speed.js';
import { planCloudGrid } from './cloud-grid.js';
import { planCompanions } from './companions.js';
import { planLoginOnce } from './login-once.js';
import { planOpenApi } from './openapi.js';
import { planOrgPolicy } from './org-policy.js';
import type { Capability, CapabilityInput, CapabilityPlan, PlanOutcome } from './shared.js';
import { planTestData } from './test-data.js';

export * from './shared.js';

/** Works out what a capability would write, without writing anything. */
export async function planCapability(store: ProjectStore, config: Config, capability: Capability, input: CapabilityInput): Promise<PlanOutcome> {
    switch (capability) {
        case 'login-once':
            return planLoginOnce(store, config);
        case 'test-data':
            return planTestData(store, config);
        case 'ci-speed':
            return planCiSpeed(store, config, input.shards ?? 4, input.ciProvider);
        case 'cloud-grid':
            return planCloudGrid(store, config, input.provider);
        case 'openapi':
            return planOpenApi(store, config, input.spec, input.allowProduction ?? false, input.fetch);
        case 'companions':
            return planCompanions(store, config, input.servers);
        case 'org-policy':
            return planOrgPolicy(store, config, input.policy, input.fetch);
    }
}

/** Token that proves the apply call writes exactly what the preview showed. */
export function planToken(plan: CapabilityPlan): string {
    const fingerprint = plan.files.map(f => [f.path, f.status, createHash('sha256').update(f.content).digest('hex').slice(0, 16)]);
    return `cap-${plan.capability}-${digestOf({ fingerprint, install: plan.install }).slice(0, 20)}`;
}
