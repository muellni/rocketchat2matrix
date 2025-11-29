export const enum Entity {
  Users = 'users',
  Rooms = 'rooms',
  Messages = 'messages',
  CustomEmojis = 'customEmojis',
  Uploads = 'uploads',
}

type EntityConfig = {
  filename: string
  mappingType: number
}

export const entities: {
  [key in Entity]: EntityConfig
} = {
  users: {
    filename: 'users.json',
    mappingType: 0,
  },
  rooms: {
    filename: 'rocketchat_room.json',
    mappingType: 1,
  },
  messages: {
    filename: 'rocketchat_message.json',
    mappingType: 2,
  },
  customEmojis: {
    filename: 'rocketchat_custom_emoji.json',
    mappingType: 3,
  },
  uploads: {
    filename: 'rocketchat_uploads.json',
    mappingType: 4,
  },
}

