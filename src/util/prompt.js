import Promise, { CancellationError } from "bluebird";

export const MAX_PROMPT_ATTEMPTS = 3;

Promise.config({ cancellation: true });

const validators = {
    float: message => {
        const input = parseFloat(message.content);

        if(isNaN(input)) {
            throw new Error("Invalid input. Please provide a number.");
        }

        return input;
    },

    "default": input => input
}

export class Prompt {
    constructor(person, input) {
        if(typeof input === "string") {
            input = { message: input };
        }

        if(input.validate && typeof input.validate === "string") {
            input.validate = validators[input.validate];
        }

        this.person = person;
        this.value = null;
        this.options = {
            validate: validators["default"],
            maxAttempts: MAX_PROMPT_ATTEMPTS,
            ...input
        };
    }

    run() {
        return this.promise = new Promise((resolve, reject) => {
            this.reject = reject;
            this.resolve = resolve;

            this.person.on("message:received", this.handler = (message) => {
                Promise.try(this.options.validate.bind(null, message)).then(this.finalize.bind(this)).catch(err => {
                    if(attempt < this.options.maxAttempts) {
                        attempt++;
                        return this.person.sendMessage(`${err.message} (${this.options.maxAttempts - attempt} attempts remaining)`);
                    } else throw new Error("Max attempts reached for prompt. Exiting.");
                }).catch(reject);
            });

            this.person.sendMessage(this.options.message);
        });
    }

    finalize(value) {
        this.person.removeListener("message", this.handler);

        this.resolve(this.value = value);
    }

    cancel(message) {
        if(!this.reject) {
            throw new Error("Prompt has not started, cannot cancel.");
        }

        this.reject(new CancellationError(message));
    }

    isPending() {
        if(this.promise) {
            return this.promise.isPending();
        } else return false;
    }
}

export default function prompt(person, input) {
    return (new Prompt(person, input)).run();
};