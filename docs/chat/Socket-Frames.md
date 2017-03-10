# Socket Frames
### `room.message.created` (received)
Fired when a message is created. 

```json
{
    "validator": {},
    "contentType": "object",
    "name": "room.message.created",
    "contents": {
        "id": 52,
        "body": "howya lad",
        "installationId": 1,
        "roomId": 2,
        "userId": 1,
        "type": "message",
        "editedAt": null,
        "createdAt": "2017-01-29T18:06:34.640Z",
        "containsSnippet": 0,
        "containsLink": 0,
        "file": {},
        "shard": 6
    }
}
```

### `user.modified` (received)
Update a user's value.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "user.modified",
    "contents": {
        "userId": 185144,
        "shard": 6,
        "key": "status",
        "value": "away"
    }
}
```

### `user.updated` (received)
Happens when a user has been updated in projects and need's to be updated from the API.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "user.updated",
    "contents": {
        "id": 139099
    }
}
```

### `room.user.active` (sent)
Sent when a user changes to room.

```json
{
    "contentType": "object",
    "name": "room.user.active",
    "contents": {
        "roomId": 619,
        "date": "2017-01-30T13:17:08.000Z"
    },
    "source": {
        "name": "Teamwork Chat",
        "version": "0.23.14"
    },
    "nonce": 5,
    "uid": null,
    "nodeId": null
}
```

### `unseen.counts.request` (request)
Request frame:

```json
{
    "contentType": "object",
    "name": "unseen.counts.request",
    "contents": {},
    "source": {
        "name": "Teamwork Chat",
        "version": "0.23.14"
    },
    "nonce": 109,
    "uid": null,
    "nodeId": null
}
```

Response frame:

```json
{
    "validator": {},
    "contentType": "object",
    "name": "unseen.counts.updated",
    "contents": {
        "unreadCounts": {
            "importantUnread": 10,
            "unread": 479
        },
        "conversationUnreadCounts": null,
        "connectionId": 2606784
    }
}
```

### `room.typing`
Updating typing status.


```json
{
    "validator": {},
    "contentType": "object",
    "name": "room.typing",
    "contents": {
        "isTyping": true,
        "userId": 139099, // According to the chat-server code, this isn't used.
        "roomId": 181552
    }
}
```

### `user.added`
When a user is added in projects.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "user.added",
    "contents": {
        "id": 125943
    }
}
```

### `user.deleted`
When a user is deleted in projects.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "user.deleted",
    "contents": {
        "id": 125943,
        "installationId": 385654,
        "shard": 7
    }
}
```

### `company.added`
When a new company is added to projects.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "company.added",
    "contents": {
        "id": 61825
    }
}
```

### `company.deleted`
When a company is deleted in projects.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "company.deleted",
    "contents": {
        "id": 61825
    }
}
```