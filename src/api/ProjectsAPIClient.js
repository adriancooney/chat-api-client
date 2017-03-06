// @flow
import createDebug from "debug";
import { AbstractAPIClient, HTTPError, extractTWAuthCookie } from "./CommonAPIClient";

export default class ProjectsAPIClient extends AbstractAPIClient {
    /**
     * PUT /people/<person>/impersonate.json - Impersonate a user.
     *
     * TODO: Move this to it's own Projects API Client Mixin.
     * TODO: Discuss this, ethically.
     * 
     * @param  {Number}     person  The person's ID.
     * @param  {Boolean}    revert  Revert an ongoing impersonation. Don't use this however, use `unimpersonate`. The
     *                              logic for reverting the impersonation is so close to creating the impersonation,
     *                              it would be criminal to have a seperate request method. If this method is true
     *                              (default: false), the `person` parameter is unnecessary and should be `null`.
     * @return {Promise<String>}    Resolves to the user's `tw-auth` cookie.
     */
    impersonate(person: number, revert: boolean = false) {
        return this.request(`/people/${revert ? "" : person + "/"}impersonate${revert ? "/revert" : ""}.json`, { 
            raw: true,
            method: "PUT"
        }).then(res => {
            if(res.ok) {
                return extractTWAuthCookie(res.headers.get("Set-Cookie"));
            } else throw new HTTPError(res.status, res.statusText, res);
        });
    }

    /**
     * Unimpersonate a user and refresh the auth token (because Projects returns
     * a new `tw-auth` cookie when you unimpersonate).
     * 
     * @return {Promise}  Resolves when the impersonation is complete.
     */
    unimpersonate() {
        return this.impersonate(0, true).then(auth => {
            // Update our auth token
            this.client.auth = auth;
        });
    }
}