export declare const TYPERT: {
    package: string;
    face: "host";
    schemas: never[];
    invocations: readonly import("@deepseek-ai/dsh-typert-protocol").InvocationDescriptor[];
    model: {
        services: {
            key: string;
            exportName: string;
            tags: never[];
            members: {
                kind: "method";
                name: "list" | "detail" | "create" | "update" | "delete" | "addNote" | "addEvidence" | "addThought" | "spawnAgent" | "identity" | "changes" | "applyOperations" | "syncStatus";
                signature: string;
            }[];
            types: never[];
        }[];
        events: never[];
        objects: never[];
    };
};
export default TYPERT;
