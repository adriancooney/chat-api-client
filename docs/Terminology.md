# API Terminology
Since the Teamwork API is so huge, it's good to have a consistent API so user's can infer properties by just their name.

## Methods
### Synchronous
* "new" means creating entity *in memory*.
* "load" means adding entity to collection *in memory* and entity has been "create"'d before application has started.
* "push" means adding entity to collection *in memory* however entity has been "create"'d since the application has started by external actor ("fresh").
* "remove" means remove entity from collection *in memory*.
* "find" means find entity in collection *in memory*.
* "update" means "find" existing entity *in memory* and update properties given raw data from API.
* "save" means "new" and "push", or "update" an entity to collection *in memory* given raw data from API.

### Asynchronous
* "get" means attempt to find entity in memory otherwise query remote API and "save" entity.
* "create" means "save" an entity in memory and persist it with the remote API.
* "edit" means "update" an existing entity in memory and persist it with the remote API.
* "delete" means "remove" the entity from memory and persist it with the remote API
* "add" means "save" entity to collection in memory and persisting it with the remote API.

### Notes
Any "find" or "get" operations implicitly take an ID. Any other methods will explicitly specify what property to use as a comparator.

Example:

* `getPerson` is implicitly the same as `getPersonById`.
* `getPersonByUsername` is explicitly getting a user by their "username" property.
* `findRoom` is implicitly the same as `findRoomById`.