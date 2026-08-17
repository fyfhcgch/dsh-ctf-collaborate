var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
/** Host service exposed through the Harness Typert gateway. */
let TeamRemoteService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _list_decorators;
    let _detail_decorators;
    let _create_decorators;
    let _update_decorators;
    let _delete_decorators;
    let _addNote_decorators;
    let _addEvidence_decorators;
    let _addThought_decorators;
    let _spawnAgent_decorators;
    let _identity_decorators;
    let _changes_decorators;
    let _applyOperations_decorators;
    let _syncStatus_decorators;
    return class TeamRemoteService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _list_decorators = [Remote('list')];
            _detail_decorators = [Remote('detail')];
            _create_decorators = [Remote('create')];
            _update_decorators = [Remote('update')];
            _delete_decorators = [Remote('delete')];
            _addNote_decorators = [Remote('addNote')];
            _addEvidence_decorators = [Remote('addEvidence')];
            _addThought_decorators = [Remote('addThought')];
            _spawnAgent_decorators = [Remote('spawnAgent')];
            _identity_decorators = [Remote('identity')];
            _changes_decorators = [Remote('changes')];
            _applyOperations_decorators = [Remote('applyOperations')];
            _syncStatus_decorators = [Remote('syncStatus')];
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _detail_decorators, { kind: "method", name: "detail", static: false, private: false, access: { has: obj => "detail" in obj, get: obj => obj.detail }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: obj => "create" in obj, get: obj => obj.create }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _update_decorators, { kind: "method", name: "update", static: false, private: false, access: { has: obj => "update" in obj, get: obj => obj.update }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _delete_decorators, { kind: "method", name: "delete", static: false, private: false, access: { has: obj => "delete" in obj, get: obj => obj.delete }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _addNote_decorators, { kind: "method", name: "addNote", static: false, private: false, access: { has: obj => "addNote" in obj, get: obj => obj.addNote }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _addEvidence_decorators, { kind: "method", name: "addEvidence", static: false, private: false, access: { has: obj => "addEvidence" in obj, get: obj => obj.addEvidence }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _addThought_decorators, { kind: "method", name: "addThought", static: false, private: false, access: { has: obj => "addThought" in obj, get: obj => obj.addThought }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _spawnAgent_decorators, { kind: "method", name: "spawnAgent", static: false, private: false, access: { has: obj => "spawnAgent" in obj, get: obj => obj.spawnAgent }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _identity_decorators, { kind: "method", name: "identity", static: false, private: false, access: { has: obj => "identity" in obj, get: obj => obj.identity }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _changes_decorators, { kind: "method", name: "changes", static: false, private: false, access: { has: obj => "changes" in obj, get: obj => obj.changes }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _applyOperations_decorators, { kind: "method", name: "applyOperations", static: false, private: false, access: { has: obj => "applyOperations" in obj, get: obj => obj.applyOperations }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _syncStatus_decorators, { kind: "method", name: "syncStatus", static: false, private: false, access: { has: obj => "syncStatus" in obj, get: obj => obj.syncStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        team = __runInitializers(this, _instanceExtraInitializers);
        sync;
        static inject = [];
        constructor(ctx, team, sync) {
            super(ctx, 'ctfTeam');
            this.team = team;
            this.sync = sync;
        }
        list() { return this.team.listChallenges(); }
        detail(challengeId) { return this.team.getDetail(challengeId); }
        create(input) { return this.team.createChallenge(input); }
        update(challengeId, input) { return this.team.updateChallenge(challengeId, input); }
        delete(challengeId) {
            this.team.deleteChallenge(challengeId);
            return { challengeId, deleted: true };
        }
        addNote(input) { return this.team.addNote(input); }
        addEvidence(input) { return this.team.addEvidence(input); }
        addThought(input) { return this.team.addThought(input); }
        spawnAgent(input) {
            return this.team.spawnAgent(input.challengeId, input.ownerUserId, input.prompt);
        }
        identity() { return this.sync.getIdentity(); }
        changes(input) {
            return this.sync.getChanges(input?.afterSequence ?? 0, input?.limit ?? 200);
        }
        applyOperations(input) {
            return this.sync.applyOperations(input?.operations);
        }
        syncStatus() { return this.sync.status(); }
    };
})();
export { TeamRemoteService };
export default TeamRemoteService;
