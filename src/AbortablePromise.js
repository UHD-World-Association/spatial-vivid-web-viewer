/**
 * AbortablePromise: A quick & dirty wrapper for JavaScript's Promise class that allows the underlying
 * asynchronous operation to be cancelled. It is only meant for simple situations where no complex promise
 * chaining or merging occurs. It needs a significant amount of work to truly replicate the full
 * functionality of JavaScript's Promise class. Look at Util.fetchWithProgress() for example usage.
 *
 * This class was primarily added to allow splat scene downloads to be cancelled. It has not been tested
 * very thoroughly and the implementation is kinda janky. If you can at all help it, please avoid using it :)
 */
export class AbortablePromise {

    static idGen = 0;

    constructor(promiseFunc, abortHandler) {

        let resolver;
        let rejecter;
        this.promise = new Promise((resolve, reject) => {
            resolver = resolve;
            rejecter = reject;
        });

        const promiseResolve = resolver.bind(this);
        const promiseReject = rejecter.bind(this);

        const resolve = (...args) => {
            promiseResolve(...args);
        };

        const reject = (error) => {
            promiseReject(error);
        };

        try {
            promiseFunc(resolve.bind(this), reject.bind(this));
        } catch (error) {
            reject(error);
        }
        this.abortHandler = abortHandler;
        this.id = AbortablePromise.idGen++;
    }

    then(onResolve, onReject) {
        return new AbortablePromise((resolve, reject) => {
            const settleResult = (result) => {
                if (result instanceof AbortablePromise) {
                    result.promise.then(resolve, reject);
                } else if (result instanceof Promise) {
                    result.then(resolve, reject);
                } else {
                    resolve(result);
                }
            };

            this.promise.then((value) => {
                if (!onResolve) {
                    resolve(value);
                    return;
                }
                try {
                    settleResult(onResolve(value));
                } catch (error) {
                    reject(error);
                }
            }, (error) => {
                if (!onReject) {
                    reject(error);
                    return;
                }
                try {
                    settleResult(onReject(error));
                } catch (handlerError) {
                    reject(handlerError);
                }
            });
        }, this.abortHandler);
    }

    catch(onFail) {
        return this.then(undefined, onFail);
    }

    abort(reason) {
        if (this.abortHandler) this.abortHandler(reason);
    }

}

export class AbortedPromiseError extends Error {

    constructor(msg) {
        super(msg);
    }

}
