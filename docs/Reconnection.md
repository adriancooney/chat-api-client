### Getting updates
These requests are made in order when the app reconnects:

1. https://digitalcrew.teamwork.com/chat/v2/people.json?filter%5BupdatedAfter%5D=2017-02-22T15%3A18%3A49%2B00%3A00

```json
{
    "robert": "lewandowski",
    "people": [
        {
            "id": "2",
            "firstName": "Daniel",
            "lastName": "Mackey",
            "title": "CTO/Lead Developer",
            "email": "dan@teamwork.com",
            "updatedAt": "2017-02-22T15:22:40.000Z",
            "handle": "dan",
            "status": "online",
            "avatar": "https://s3.amazonaws.com/TWFiles/1/users/u2/CC399F9CB224DC124BECF16015857BDE.jpg",
            "deleted": false,
            "roomId": 182140,
            "isCurrentUserAllowedToChatDirectly": true,
            "company": {
                "id": 1,
                "name": "Teamwork.com"
            }
        },

        ...
    ],
    "STATUS": "ok"
}
```

2. https://digitalcrew.teamwork.com/chat/v2/conversations.json?includeMessageData=true&includeUserData=true&page%5Boffset%5D=0&sort=lastActivityAt&filter%5Bstatus%5D=all&filter%5BactivityAfter%5D=2017-02-22T15%3A18%3A49%2B00%3A00

```json
{
    "conversations": [
        {
            "id": 179841,
            "title": "Teamwork Projects (feat. @joe)",
            "status": "active",
            "lastActivityAt": "2017-02-22T15:18:49.000Z",
            "lastViewedAt": "2017-02-22T15:18:49.000Z",
            "updatedAt": "2017-02-20T09:39:03.000Z",
            "creatorId": 153596,
            "createdAt": "2015-02-18T15:21:03.000Z",
            "type": "company",
            "people": [
                {
                    "lastActivityAt": "2017-02-07T10:03:13.000Z",
                    "id": 1,
                    "firstName": "Peter",
                    "lastName": "Coppinger",
                    "title": "CEO/Lead Developer",
                    "email": "peter@teamwork.com",
                    "updatedAt": "2017-02-22T15:00:31.000Z",
                    "handle": "topper",
                    "status": "online",
                    "deleted": false,
                    "roomId": 182164,
                    "isCurrentUserAllowedToChatDirectly": true,
                    "company": {
                        "id": 1,
                        "name": "Teamwork.com"
                    }
                },

                ...
            ],
            "unreadCount": 0,
            "importantUnreadCount": 0,
            "latestMessage": {
                "id": 3964147,
                "roomId": 179841,
                "body": "yeh imo it should be that way around, but I had this discussion with conor and dan a few months back when I was working on pushing dates like this and this is the way they want it",
                "userId": 175557,
                "status": "active",
                "file": {},
                "createdAt": "2017-02-22T15:18:49.000Z",
                "thirdPartyCards": [],
                "isUserActive": true,
                "userDetails": {
                    "id": 175557,
                    "firstName": "Daniel",
                    "lastName": "Robinson",
                    "title": "Software Engineer",
                    "email": "daniel.robinson@teamwork.com",
                    "updatedAt": "2017-02-22T14:35:42.000Z",
                    "handle": "danjr",
                    "status": "online",
                    "avatar": "https://s3.amazonaws.com/TWFiles/1/users/u175557/1484822934201_cosmology_cat_prof.jpg",
                    "deleted": false,
                    "roomId": null,
                    "isCurrentUserAllowedToChatDirectly": true,
                    "company": {
                        "id": 1,
                        "name": "Teamwork.com"
                    }
                }
            }
        }
    ],
    "meta": {
        "page": {
            "offset": 0,
            "limit": 10,
            "total": 1
        },
        "status": "ok"
    }
}
```

3. https://digitalcrew.teamwork.com/chat/v2/messages.json?createdAfter=2017-02-22T15%3A18%3A49%2B00%3A00&page=1&pageSize=50

```json
{
    "messages": [],
    "status": "ok"
}
```

4. https://digitalcrew.teamwork.com/chat/v2/companies.json?offset=0&filter%5BupdatedAfter%5D=2017-02-22T15%3A18%3A49%2B00%3A00&filter%5Bstatus%5D=all

```json
{
    "companies": [],
    "meta": {
        "offset": 0,
        "limit": 50,
        "total": 0
    },
    "status": "ok"
}
```