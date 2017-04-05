dimport Promise, { CancellationError, TimeoutError } from "bluebird";

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

        if(!input.message) {
            throw new Error("Please provide a message for the prompt.");
        }

        this.person = person;
        this.value = null;
        this.options = {
            validate: validators["default"],
            maxAttempts: DEFAULT_MAX_PROMPT_ATTEMPTS,
            timeout: DEFAULT_TIMEOUT,
            ...input
        };
    }

    remind() {
        return this.person.sendMessage(`@${this.person.handle}, friendly reminder that I'm still waiting for an answer.`);
    }

    run() {
        return this.promise = new Promise((resolve, reject) => {
            this.reject = reject;
            this.resolve = resolve;

            let attempt = 0;
            this.person.on("message:received", this.handler = (message) => {
                Promise.try(this.options.validate.bind(null, message))
                    .then(this.finalize.bind(this))
                    .catch(err => {
                        if(attempt < this.options.maxAttempts) {
                            attempt++;
                            return this.person.sendMessage(`${err.message} (${this.options.maxAttempts - attempt + 1} attempts remaining)`);
                        } else throw new Error("Too many attempts, sorry. I didn't understand your input.");
                    }).catch(reject);
            });

            this.person.sendMessage(this.options.message).catch(reject);
        }).timeout(this.options.timeout).tapCatch(err => {
            if(err instanceof TimeoutError) {
                return this.person.sendMessage(`Sorry, @${this.person.handle}, too slow.`);
            }
        });
    }

    finalize(value) {
        this.person.removeListener("message:received", this.handler);
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