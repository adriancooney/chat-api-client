import assert from "assert";
import APIClient, { isSubset } from "../src/APIClient";
import { INSTALLATION, USERNAME, PASSWORD, localAPIClient } from "./fixture";

describe("APIClient", () => {
    describe("isSubset", () => {
        it("should successfully check the subset", () => {
            const id = 488539;
            assert(isSubset({
                contents: {
                    roomId: `3735`,
                    ids: [ id ]
                }
            }, {
                contents: {
                    roomId: '3735',
                    ids: [ 488539 ],
                    installationId: 385654,
                    shard: 7
                }
            }));

            assert(isSubset(
                { roomId: '3735', ids: [ 488566 ] },
                { roomId: '3735',
                  ids: [ 488566 ],
                  installationId: 385654,
                  shard: 7 }
            ));
        });
    })
});