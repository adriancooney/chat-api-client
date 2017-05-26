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

### `room.message.created` (with file)

```json
{
    "contentType": "object",
    "name": "room.message.created",
    "contents": {
        "roomId": 183702,
        "body": "",
        "file": {
            "name": "spotify.js",
            "key": "cff751ae-69bf-450f-8952-5b17f70780e7.spotify.js",
            "contentType": "text/javascript"
        }
    },
    "source": {
        "name": "Teamwork Chat",
        "version": "0.25.4-rc2"
    },
    "nonce": 9,
    "uid": null,
    "nodeId": null
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

### `room.updated`
Called when a room is created or updated.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "room.updated",
    "contents": {
        "id": 5594
    }
}
```

### `room.deleted`

```json
{
    "validator": {},
    "contentType": "object",
    "name": "room.deleted",
    "contents": {
        "id": 5594,
        "installationId": 385654,
        "shard": 7
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

### `company.updated`

```json
{
    "validator": {},
    "contentType": "object",
    "name": "company.updated",
    "contents": {
        "id": 74464
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

### `room.message.updated`
When a message is updated.

```json
{
    "validator": {},
    "contentType": "object",
    "name": "room.message.updated",
    "contents": {
        "userId": 120606,
        "installationId": 385654,
        "roomId": 3735,
        "id": 487643,
        "thirdPartyCards": [
            {
                "type": "video",
                "isActive": true,
                "title": "Canterbury Park Corgi Races 7-30-2016",
                "description": "Canterbury Park Corgi Races 7-30-2016.... 6 Heats and the Final!",
                "providerName": "YouTube",
                "providerUrl": "https://www.youtube.com/",
                "html": "<iframe class=\"embedly-embed\" src=\"https://cdn.embedly.com/widgets/media.html?src=https%3A%2F%2Fwww.youtube.com%2Fembed%2FtPuKyeVsfZY%3Ffeature%3Doembed&url=http%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DtPuKyeVsfZY&image=https%3A%2F%2Fi.ytimg.com%2Fvi%2FtPuKyeVsfZY%2Fhqdefault.jpg&key=3a97319f77a8406a92b3b82c1990d836&type=text%2Fhtml&schema=youtube\" width=\"854\" height=\"480\" scrolling=\"no\" frameborder=\"0\" allowfullscreen></iframe>",
                "url": "https://www.youtube.com/watch?v=tPuKyeVsfZY",
                "faviconUrl": "https://s.ytimg.com/yts/img/favicon-vflz7uhzw.ico",
                "isSafe": true,
                "providerDisplay": "www.youtube.com",
                "language": "en",
                "lead": null,
                "thumbnailWidth": 480,
                "thumbnailHeight": 360
            }
        ]
    },
    "nonce": 4
}
```

### `room.message.deleted`

```json
{
    "contentType": "object",
    "name": "room.messages.deleted",
    "uid": "385654-3735",
    "contents": {
        "roomId": "3735",
        "ids": [
            487643
        ],
        "installationId": 385654,
        "shard": 7
    }
}
```

### `room.message.deleted-undone`

```json
{
    "contentType": "object",
    "name": "room.messages.deleted-undone",
    "uid": "385654-3735",
    "contents": {
        "roomId": "3735",
        "ids": [
            487668
        ],
        "installationId": 385654,
        "shard": 7
    }
}
```