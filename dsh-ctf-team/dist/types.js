export class TeamInputError extends Error {
    kind;
    constructor(message, kind = 'invalid') {
        super(message);
        this.kind = kind;
        this.name = 'TeamInputError';
    }
}
export class TeamNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TeamNotFoundError';
    }
}
