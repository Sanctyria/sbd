export interface DemoAccount {
  id: string;
  username: string;
  displayName: string;
  initials: string;
  avatarColor: string;
  bio: string;
  verified?: boolean;
}

export interface DemoCommunity {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface DemoReply {
  id: string;
  author: string;
  body: string;
}

export interface DemoPost {
  id: string;
  author: string;
  community: string;
  kind: "text" | "link" | "image_url" | "video_url";
  body: string;
  url?: string;
  linkTitle?: string;
  linkDescription?: string;
  linkDomain?: string;
  votes: number;
  minutesAgo: number;
  replies: DemoReply[];
}

export const demoAccounts: DemoAccount[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    username: "sanctyria-guest",
    displayName: "Sanctyria Guest",
    initials: "G",
    avatarColor: "#cf6f65",
    bio: "A community demo account.",
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    username: "miravoss",
    displayName: "Mira Voss",
    initials: "MV",
    avatarColor: "#9d5438",
    bio: "Stories, memory, and the histories people keep.",
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    username: "sanctyria",
    displayName: "Sanctyria Journal",
    initials: "S",
    avatarColor: "#ef6a32",
    bio: "Official journal dispatches from Sanctyria.",
    verified: true,
  },
  {
    id: "88888888-8888-4888-8888-888888888888",
    username: "arensol",
    displayName: "Aren Sol",
    initials: "AS",
    avatarColor: "#466578",
    bio: "Visual studies and quiet places between territories.",
  },
  {
    id: "99999999-9999-4999-8999-999999999999",
    username: "noorsayegh",
    displayName: "Noor Sayegh",
    initials: "NS",
    avatarColor: "#7c5a7c",
    bio: "Sound references and atmospheric transitions.",
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    username: "julesferren",
    displayName: "Jules Ferren",
    initials: "JF",
    avatarColor: "#66744b",
    bio: "Map questions, practical roads, and where stories begin.",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    username: "liomaren",
    displayName: "Lio Maren",
    initials: "LM",
    avatarColor: "#9b704e",
    bio: "Legends, prompts, and thoughtful critique.",
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    username: "tarinhale",
    displayName: "Tarin Hale",
    initials: "TH",
    avatarColor: "#476259",
    bio: "Maps and old histories.",
  },
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    username: "elirowan",
    displayName: "Eli Rowan",
    initials: "ER",
    avatarColor: "#596684",
    bio: "Writing and lore.",
  },
];

export const demoCommunities: DemoCommunity[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "worldbuilding",
    name: "Worldbuilding",
    description: "Make worlds with history and texture.",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "the-archive",
    name: "The Archive",
    description: "Journal dispatches and recovered records from the world.",
  },
  {
    id: "e1111111-1111-4111-8111-111111111111",
    slug: "writing-room",
    name: "Writing Room",
    description: "Drafts, prompts, and thoughtful critique.",
  },
  {
    id: "e2222222-2222-4222-8222-222222222222",
    slug: "visual-studies",
    name: "Visual Studies",
    description: "Concepts, references, and art direction.",
  },
  {
    id: "e3333333-3333-4333-8333-333333333333",
    slug: "studio-notes",
    name: "Studio Notes",
    description: "Music, sound, and process notes.",
  },
];

export const demoPosts: DemoPost[] = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    author: "miravoss",
    community: "worldbuilding",
    kind: "text",
    body: "A world feels lived in when its people remember different versions of the same story. What small disagreement in your setting says the most about its history?",
    votes: 42,
    minutesAgo: 18,
    replies: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        author: "tarinhale",
        body: "Two villages both claim the old bridge was built by their ancestors. Their records almost agree, which makes the argument last forever.",
      },
      {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        author: "elirowan",
        body: "That “almost agree” is excellent. It lets both communities be right in the ways that matter to them.",
      },
    ],
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    author: "sanctyria",
    community: "the-archive",
    kind: "link",
    body: "A field note on the cultures, borders, and lived details behind the eight nations.",
    url: "https://sanctyria.com/journal/eight-nations-one-sky",
    linkTitle: "Eight Nations, One Sky",
    linkDescription:
      "A map can show where a border runs. It takes a people to tell you what that border means.",
    linkDomain: "sanctyria.com",
    votes: 31,
    minutesAgo: 46,
    replies: [],
  },
  {
    id: "66666666-6666-4666-8666-666666666667",
    author: "arensol",
    community: "visual-studies",
    kind: "image_url",
    body: "Light study for a quiet place between territories. Keeping the palette restrained helped the water feel like a boundary instead of a destination.",
    url: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1400&q=85",
    votes: 27,
    minutesAgo: 60,
    replies: [],
  },
  {
    id: "77777777-7777-4777-8777-777777777778",
    author: "noorsayegh",
    community: "studio-notes",
    kind: "video_url",
    body: "A sound reference for slow, atmospheric scene transitions. Curious what details you notice first.",
    url: "https://youtu.be/ysz5S6PUM-U",
    votes: 19,
    minutesAgo: 120,
    replies: [],
  },
  {
    id: "88888888-8888-4888-8888-888888888889",
    author: "julesferren",
    community: "worldbuilding",
    kind: "text",
    body: "Question for the mapmakers: how do you decide where a road stops being practical and starts becoming part of the story?",
    votes: 16,
    minutesAgo: 180,
    replies: [],
  },
  {
    id: "99999999-9999-4999-8999-999999999998",
    author: "liomaren",
    community: "writing-room",
    kind: "link",
    body: "A useful reminder from the journal: a legend can be more than lore when readers recognize something human inside it.",
    url: "https://sanctyria.com/journal/the-flame-that-remembers",
    linkTitle: "The Flame That Remembers",
    linkDescription:
      "Memory in Sanctyria is personal and imperfect. The Flame carries choices forward.",
    linkDomain: "sanctyria.com",
    votes: 12,
    minutesAgo: 300,
    replies: [],
  },
];

export const guestMembershipSlugs = ["worldbuilding", "visual-studies"];
