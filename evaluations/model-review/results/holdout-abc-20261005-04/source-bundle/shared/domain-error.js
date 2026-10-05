export class DomainError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
//# sourceMappingURL=domain-error.js.map