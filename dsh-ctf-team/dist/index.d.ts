import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-ctf-team";
/** Current Cordis 4 Standard Schema configuration contract. */
export declare const Config: Schema<Schemastery.ObjectS<{
    dbPath: Schema<string, string>;
    agentConcurrentLimit: Schema<number, number>;
    webMountPath: Schema<string, string>;
    enableHttpBridge: Schema<boolean, boolean>;
    teamId: Schema<string, string>;
    identityPath: Schema<string, string>;
}>, Schemastery.ObjectT<{
    dbPath: Schema<string, string>;
    agentConcurrentLimit: Schema<number, number>;
    webMountPath: Schema<string, string>;
    enableHttpBridge: Schema<boolean, boolean>;
    teamId: Schema<string, string>;
    identityPath: Schema<string, string>;
}>>;
/**
 * Process-wide collaboration store. This is intentionally a plain Cordis plugin:
 * it provides no global service and owns every cleanup action through its Fiber.
 */
export declare function apply(ctx: any, config: any): void;
