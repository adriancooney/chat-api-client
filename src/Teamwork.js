// @flow
import Collection from "./lib/Collection";
import TeamworkAPIClient from "./api";
import { Person } from "./model";
import Projects from "./Projects";

export default class Teamwork extends Person {
    constructor(client: TeamworkAPIClient) {
        super(client);

        this.people = new Collection();
        this.projects = new Projects(this);
    }
}