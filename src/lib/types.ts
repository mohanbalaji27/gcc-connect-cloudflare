import type { ReviewVisibility } from './menuCatalog';
import type { Theme } from './theme';

export type Role = 'user' | 'admin' | 'super_admin';
// Permissions come from the server's catalogue (config.permissionCatalog); the browser keeps no list of its own.
export type Permission = string;
export interface PermissionInfo { id: string; label: string; description: string; grant: 'any' | 'super' | 'reserved' }
export interface PermissionGroup { id: string; label: string; icon: string; permissions: PermissionInfo[] }
export interface PermissionCatalog { groups: PermissionGroup[]; adminDefaults: Permission[] }
export interface NotificationType { id: string; label: string; description: string; group: string; requires: Permission | null; default: boolean }
export interface NotificationChannel { id: string; label: string; available: boolean; comingSoon?: boolean }
export interface NotificationCatalog { channels: NotificationChannel[]; types: NotificationType[] }

export interface User {
  id: string; email: string; name: string; team: string; role: Role;
  permissions: Permission[]; mustChangePassword: boolean;
  avatar: string; roleName: string | null; showInWhosin: boolean; birthMonth: number | null; birthDay: number | null;
  username: string | null; simpleUi: boolean; landing: string;
}
export interface Team { id: string; name: string; color: string; seatCount: number }
export interface TeamRef { id: string; name: string; color: string }
export interface Resource {
  id: string; type: 'desk' | 'room'; label: string; building: string; floor: string; zone: string;
  description: string; amenities: string[]; capacity: number | null;
  x: number | null; y: number | null; gridRow: number | null; gridCol: number | null; labelSide: 'top' | 'bottom' | 'left' | 'right' | null;
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
  rsvp_enabled?: boolean;
}
export interface Summary { streak: number; monthCount: number; totalVisits: number; desksTotal: number; desksLeftToday: number }
export interface ManagedUser {
  id: string; email: string; username: string | null; name: string; team: string; role: Role; active: boolean; permissions: Permission[];
  ownPermissions: Permission[]; customRoleId: string | null; joinedOn: string;
}
export interface MapInfo { calibration: { x0: number; y0: number; x1: number; y1: number }; floorPlanAvailable: boolean; floorPlanVersion: number }
export interface TokenRow {
  id: string; expires_at: string | null; max_redemptions: number | null; redemption_count: number;
  revoked: boolean; created_at: string; label: string; type: string;
}
export interface AuditEntry {
  id: string; at: string; action: string; area: string; areaLabel: string; title: string; text: string;
  actorId: string | null; actorName: string | null; detail: string; entityId: string | null;
}
export interface AuditPage { entries: AuditEntry[]; hasMore: boolean; next: string | null; total?: number; areas?: { id: string; label: string }[] }

export const EVENT_CATEGORIES = ['Learning', 'Community', 'Company', 'Social', 'Wellness', 'Team'];

export type FeatureKey = 'links' | 'contacts' | 'menu' | 'announcements' | 'issues' | 'kudos' | 'polls' | 'celebrations' | 'feedback' | 'whosin' | 'vibes';
export type LogoSlot = 'header' | 'login' | 'icon192' | 'icon512' | 'favicon' | 'headerDark' | 'loginDark';
export interface LogoMeta { v: string; slots: LogoSlot[]; bg: string | null }
export interface Branding {
  appName: string; shortName: string; tagline: string; welcome: string;
  /** A preset id (green, ocean, ..., zimmer) or "custom" (then `theme` holds the colours). */
  accent: string; theme: Theme | null;
  logoHeight: number; logoAlign: 'left' | 'center'; logoDisplay: 'logo' | 'logo-text' | 'text';
}
export interface LoginConfig {
  title: string; subtitle: string; cardTitle: string; cardText: string;
  background: 'gradient' | 'solid' | 'pattern' | 'image'; card: 'solid' | 'glass' | 'outlined';
  showLogo: boolean; showTip: boolean; bullets: string[];
  footerText: string; footerLinks: { label: string; url: string }[]; forgotHelp: string; usernameHint: string;
}
export type HomeCardId = 'hero' | 'news' | 'stats' | 'quick' | 'menu' | 'whosin' | 'celebrate' | 'contacts' | 'links' | 'events' | 'tip';
export interface HomeConfig { layout: { id: HomeCardId; on: boolean }[]; greeting: string }
export interface PublicConfig { branding: Branding; login: LoginConfig; logo: LogoMeta; passwordMinLength: number }
export type SettingValue = boolean | number | string;
export interface SettingDef {
  key: string; section: string; group: string; type: 'boolean' | 'integer' | 'enum' | 'object';
  label: string; help: string; affects: string; default: SettingValue | null; min?: number; max?: number; unit?: string; options?: [string, string][];
}
export interface SettingsSchema {
  sections: { id: string; label: string; icon: string; blurb: string }[]; settings: SettingDef[];
  homeCards: { id: HomeCardId; label: string; hint: string }[]; themeFields: string[];
}
export type OptionKey = 'showBookerNames' | 'eventsRsvpEnabled' | 'issuePhotosEnabled' | 'homeContacts' | 'usageAnalytics';
export interface AppConfig {
  features: Record<FeatureKey, boolean>; branding: Branding; login: LoginConfig; home: HomeConfig; logo: LogoMeta;
  /** Every scalar setting by its key (see server/settings-registry.js). */
  settings: Record<string, SettingValue>; settingsSchema?: SettingsSchema;
  options: Record<OptionKey, boolean>; featureCatalog: Record<FeatureKey, string>; optionCatalog: Record<OptionKey, string>; accents: string[];
  menuReviewsVisibility: ReviewVisibility; menuHistoryDays: number; usageRetentionDays: number; homeContactsCount: number;
  permissionCatalog: PermissionCatalog; notificationCatalog: NotificationCatalog;
}
export interface HomeContact { id: string; name: string; role_title: string; phone: string; email: string; hours: string; emoji: string }
export interface Bootstrap {
  configVersion: number; user: User; config: AppConfig; teams: Team[]; unassignedSeats: number; map: MapInfo; summary: Summary; unread: number; homeContacts: HomeContact[];
}
export interface LinkItem { id: string; title: string; url: string; description: string; category: string; emoji: string; sort_order: number }
export interface ContactItem { id: string; name: string; role_title: string; category: string; phone: string; email: string; hours: string; notes: string; emoji: string; sort_order: number; pin_to_home?: boolean }
export type { MenuDish as MenuItem } from './menuData';
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
export interface NotifyDefaults { types?: Record<string, { inapp?: boolean }>; categories?: string[] }
export interface CustomRole {
  id: string; name: string; description: string; emoji: string; permissions: Permission[]; people?: number;
  systemKey?: string | null; simpleUi?: boolean; landing?: string; notifyDefaults?: NotifyDefaults;
}
export type IssueStatus = 'new' | 'acknowledged' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
export type IssuePriority = 'low' | 'normal' | 'high' | 'urgent';
export interface IssueCategory { id: string; name: string; emoji: string; description: string; defaultPriority: IssuePriority }
export interface Issue {
  id: string; number: number; title: string; description: string; categoryId: string; categoryName: string; categoryEmoji: string;
  locationText: string; resourceId: string | null; priority: IssuePriority; status: IssueStatus; reporterId: string; reporterName?: string;
  assigneeId: string | null; assigneeName: string | null; createdAt: string; updatedAt: string; resolvedAt: string | null;
  plusOnes: number; overdue: boolean; photoVersion: number | null; mine: boolean;
}
export interface IssueUpdate { id: string; kind: 'comment' | 'status' | 'assign' | 'priority' | 'reopen' | 'help'; body: string; internal: boolean; from: string | null; to: string | null; createdAt: string; authorId: string | null; authorName: string | null }
export interface IssueDetail { issue: Issue; updates: IssueUpdate[]; can: { reopen: boolean; work: boolean; assign: boolean; comment: boolean; internalNote: boolean; photo: boolean } }
export interface IssueCounts { open: number; new: number; unassigned: number; mine: number; overdue: number }
export interface AppNotification { id: string; type: string; title: string; body: string; link: string; data: Record<string, unknown>; createdAt: string; readAt: string | null }
export interface FeedbackItem { id: string; category: string; message: string; status: 'new' | 'seen' | 'done'; created_at: string; from_name: string | null }
export interface Insights {
  today: string;
  officeHours: { from: number; to: number };
  totals: {
    people: number; desks: number; rooms: number; desksToday: number; roomsToday: number; deskUtilisationToday: number; roomUtilisationToday: number; deskCoverage30d: number;
    activeBookers30d: number; bookings30d: number; deskBookings30d: number; roomBookings30d: number; cancelled30d: number;
    kudos30d: number | null; votes30d: number | null; feedbackNew: number | null; eventsUpcoming: number; rsvpsUpcoming: number | null;
  };
  trend: { date: string; desks: number; rooms: number; future: boolean }[];
  byTeam: { name: string; color: string; seats: number; bookings: number }[];
  topSpaces: { label: string; type: string; n: number }[];
  weekdays: { name: string; days: number; desks: number; rooms: number; avgDesks: number }[];
}
export interface UsageFeatureRow { id: string; label: string; opens: number; users: number; prevOpens: number; prevUsers: number }
export interface UsageSummary {
  from: string; to: string; days: number; previous: { from: string; to: string }; collecting: boolean; retentionDays: number;
  since: { features: string | null; logins: string | null };
  series: { date: string; logins: number; loginPeople: number; active: number }[];
  totals: { logins: number; activePeople: number; avgDailyActive: number; people: number };
  reach: { dau: number; wau: number; mau: number; stickiness: number };
  cohort: { current: number; previous: number; retained: number; retention: number; newPeople: number; returningPeople: number };
  features: UsageFeatureRow[]; unused: { id: string; label: string }[]; hours: { hour: number; n: number }[];
  teams: { team: string; people: number; active: number }[];
}

export const KUDOS_BADGES: Record<string, { emoji: string; label: string }> = {
  star: { emoji: '🌟', label: 'Star' }, team: { emoji: '🤝', label: 'Team player' }, idea: { emoji: '💡', label: 'Bright idea' },
  fire: { emoji: '🔥', label: 'On fire' }, helper: { emoji: '🙌', label: 'Lifesaver' }, coffee: { emoji: '☕', label: 'Coffee-worthy' },
};
export const AVATARS = ['🦊', '🐼', '🦉', '🐙', '🦄', '🐢', '🦋', '🐬', '🦁', '🐨', '🐝', '🦖', '🌵', '🍕', '🚀', '🎸'];
export { MEALS } from './menuCatalog';
