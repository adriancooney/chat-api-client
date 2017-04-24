import Promise, { CancellationError, TimeoutError } from "bluebird";

export const DEFAULT_MAX_PROMPT_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT = 30 * 1000;

Promise.config({ cancellation: true });

const validators = {
    float: message => {
        const { content } = message;

        if(content.trim() === "infinity") {
            throw new Error("Really? Infinity? I'm not that stupid.");
        }

        const input = parseFloat(content);

        if(isNaN(input)) {
            throw new Error("Sorry, I didn't understand that. Please provide a number.");
        }

        return input;
    },

    int: message => {
        const { content } = message;

        const input = parseInt(content, 10);

        if(isNaN(input)) {
            throw new Error("Sorry, I need an number please (and not a decimal).");
        }

        return input;
    },

    "default": input => input
}

export class Prompt {
    constructor(target, input) {
        if(typeof input === "string") {
            input = { message: input };
        }

        if(input.validate && typeof input.validate === "string") {
            input.validate = validators[input.validate];
        }

        if(!input.message) {
            throw new Error("Please provide a message for the prompt.");
        }

        this.target = target;
        this.options = {
            validate: validators["default"],
            maxAttempts: DEFAULT_MAX_PROMPT_ATTEMPTS,
            timeout: DEFAULT_TIMEOUT,
            ...input
        };

        this.value = null;
        this.error = null;
    }

    run() {
        this.value = this.error = null;
        return this.promise = new Promise((resolve, reject) => {
            this.reject = reject;
            this.resolve = resolve;

            let attempt = 0;
            this.target.on("message:received", this.handler = (message) => {
                Promise.try(this.options.validate.bind(null, message))
                    .then(this.finalize.bind(this))
                    .catch(err => {
                        if(attempt < this.options.maxAttempts) {
                            attempt++;
                            return this.target.sendMessage(`${err.message} (${this.options.maxAttempts - attempt + 1} attempts remaining)`);
                        } else throw Object.assign(
                            new Error("Too many attempts, sorry. I didn't understand your input."),
                            { attempt, maxAttempts: this.options.maxAttempts }
                        );
                    })
                    .catch(this.fail.bind(this));
            });

            this.target.sendMessage(this.options.message).catch(this.fail.bind(this));
        }).timeout(this.options.timeout).tapCatch(err => {
            if(err instanceof TimeoutError) {
                return this.target.sendMessage(`Sorry, too slow.`);
            }
        });
    }

    finalize(value) {
        if(this.resolve) {
            this.value = value;
            this.error = null;
            this.resolve(value);
            this.close();
        }
    }

    fail(error) {
        if(this.reject) {
            this.value = null;
            this.error = error;
            this.reject(error);
            this.close();
        }
    }

    close() {
        this.resolve = this.reject = null;
        this.target.removeListener("message:received", this.handler);
        this.closed = true;
    }

    cancel(message) {
        if(!this.isPending()) {
            throw new Error("Prompt has not started, cannot cancel.");
        }

        this.fail(new CancellationError(message));
    }

    isPending() {
        if(this.promise) {
            return this.promise.isPending();
        } else return false;
    }
}

export default function prompt(target, input) {
    return (new Prompt(target, input)).run();
};