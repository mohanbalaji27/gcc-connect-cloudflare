export type Role = 'user' | 'admin' | 'super_admin';
export type Permission = 'bookings.manage' | 'events.manage' | 'spaces.manage' | 'teams.manage' | 'qr.manage' | 'users.manage' | 'content.manage' | 'menu.manage' | 'community.manage' | 'insights.view';

export interface User {
  id: string; email: string; name: string; team: string; role: Role;
  permissions: Permission[]; mustChangePassword: boolean;
  avatar: string; roleName: string | null; showInWhosin: boolean; birthMonth: number | null; birthDay: number | null;
}
export interface Team { id: string; name: string; color: string; seatCount: number }
export interface TeamRef { id: string; name: string; color: string }
export interface Resource {
  id: string; type: 'desk' | 'room'; label: string; building: string; floor: string; zone: string;
  description: string; amenities: string[]; capacity: number | null;
  x: number | null; y: number | null; gridRow: number | null; gridCol: number | null;
  team: TeamRef | null; active: boolean; available: boolean | null; bookedBy?: string;
}
export interface Booking {
  id: string; resource_id: string; starts_at: string; ends_at: string; status: string;
  type: 'desk' | 'room'; label: string; building: string; floor: string; zone: string;
}
export interface AdminBooking {
  id: string; resource_id: string; starts_at: string; ends_at: string; type: 'desk' | 'room';
  label: string; employee_name: string; employee_email: string;
}
export interface OfficeEvent {
  id: string; title: string; description: string; starts_at: string; ends_at: string; venue: string;
  category: string; audience: string; going_count: number; going: boolean; links: { label: string; url: string }[];
}
export interface Summary { streak: number; monthCount: number; totalVisits: number; desksTotal: number; desksLeftToday: number }
export interface ManagedUser {
  id: string; email: string; name: string; team: string; role: Role; active: boolean; permissions: Permission[];
  ownPermissions: Permission[]; customRoleId: string | null; joinedOn: string;
}
export interface MapInfo { calibration: { x0: number; y0: number; x1: number; y1: number }; floorPlanAvailable: boolean }
export interface TokenRow {
  id: string; expires_at: string | null; max_redemptions: number | null; redemption_count: number;
  revoked: boolean; created_at: string; label: string; type: string;
}
export interface AuditEntry { id: string; action: string; entity_id: string | null; detail: string; created_at: string; actor_name: string | null }

export const PERMISSION_LABELS: Record<Permission, string> = {
  'bookings.manage': 'See and cancel anyone’s bookings',
  'events.manage': 'Create, edit and delete events',
  'spaces.manage': 'Add, edit, move and retire desks and rooms',
  'teams.manage': 'Create teams and assign seats to them',
  'qr.manage': 'Create booking QR codes',
  'users.manage': 'Create users, set roles and permissions',
  'content.manage': 'Manage links, contacts and announcements',
  'menu.manage': 'Manage the food menu',
  'community.manage': 'Run polls, moderate kudos, read feedback',
  'insights.view': 'See the insights dashboard',
};
export const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS) as Permission[];
export const EVENT_CATEGORIES = ['Learning', 'Community', 'Company', 'Social', 'Wellness', 'Team'];

export type FeatureKey = 'links' | 'contacts' | 'menu' | 'announcements' | 'kudos' | 'polls' | 'celebrations' | 'feedback' | 'whosin' | 'vibes';
export interface Branding { appName: string; tagline: string; accent: string; welcome: string }
export interface AppConfig { features: Record<FeatureKey, boolean>; branding: Branding; featureCatalog: Record<FeatureKey, string>; accents: string[] }
export interface LinkItem { id: string; title: string; url: string; description: string; category: string; emoji: string; sort_order: number }
export interface ContactItem { id: string; name: string; role_title: string; category: string; phone: string; email: string; hours: string; notes: string; emoji: string; sort_order: number }
export interface MenuItem { id: string; date: string; meal: 'breakfast' | 'lunch' | 'snacks' | 'dinner'; name: string; description: string; diet: 'veg' | 'non-veg' | 'vegan' | 'egg'; emoji: string; likes: number; liked: boolean }
export interface Announcement { id: string; title: string; body: string; emoji: string; pinned: boolean; expires_at: string | null; created_at: string }
export interface Kudos { id: string; badge: string; message: string; created_at: string; from_id: string; from_name: string; from_avatar: string; to_id: string; to_name: string; to_avatar: string; cheers: number; cheered: boolean }
export interface Poll { id: string; question: string; options: string[]; counts: number[]; total: number; myVote: number | null; open: boolean; closesAt: string | null }
export interface Celebration { id: string; personId: string; name: string; avatar: string; kind: 'birthday' | 'anniversary'; daysAway: number; years?: number; label: string }
export interface Person { id: string; name: string; team: string; avatar: string }
export interface WhosIn { date: string; total: number; hidden: number; people: { id: string; name: string; team: string; avatar: string; desk: string }[] }
export interface Vibes {
  points: number; level: { name: string; emoji: string; index: number; min: number };
  next: { name: string; emoji: string; remaining: number; progress: number } | null;
  badges: { id: string; emoji: string; name: string; hint: string; earned: boolean }[];
}
export interface CustomRole { id: string; name: string; description: string; emoji: string; permissions: Permission[]; people?: number }
export interface FeedbackItem { id: string; category: string; message: string; status: 'new' | 'seen' | 'done'; created_at: string; from_name: string | null }
export interface Insights {
  today: string;
  totals: {
    people: number; desks: number; rooms: number; desksToday: number; roomsToday: number; deskUtilisationToday: number; deskCoverage30d: number;
    activeBookers30d: number; bookings30d: number; cancelled30d: number; kudos30d: number; votes30d: number; feedbackNew: number; eventsUpcoming: number; rsvpsUpcoming: number;
  };
  trend: { date: string; desks: number; rooms: number; future: boolean }[];
  byTeam: { name: string; color: string; seats: number; bookings: number }[];
  topSpaces: { label: string; type: string; n: number }[];
  weekdays: { name: string; n: number }[];
}

export const KUDOS_BADGES: Record<string, { emoji: string; label: string }> = {
  star: { emoji: '🌟', label: 'Star' }, team: { emoji: '🤝', label: 'Team player' }, idea: { emoji: '💡', label: 'Bright idea' },
  fire: { emoji: '🔥', label: 'On fire' }, helper: { emoji: '🙌', label: 'Lifesaver' }, coffee: { emoji: '☕', label: 'Coffee-worthy' },
};
export const AVATARS = ['🦊', '🐼', '🦉', '🐙', '🦄', '🐢', '🦋', '🐬', '🦁', '🐨', '🐝', '🦖', '🌵', '🍕', '🚀', '🎸'];
export const MEALS: Record<string, { label: string; emoji: string }> = {
  breakfast: { label: 'Breakfast', emoji: '🥞' }, lunch: { label: 'Lunch', emoji: '🍛' }, snacks: { label: 'Snacks', emoji: '🍪' }, dinner: { label: 'Dinner', emoji: '🌙' },
};
