export interface AdminUser {
  stableUid: string;
  username: string;
  webuntisKlasseId: number | null;
  webuntisKlasseName: string | null;
  classId: string | null;
  classCode: string | null;
  isAdmin: boolean;
  // Set while a WebUntis account made admin has not signed in with its
  // one-time password yet; the grant lapses at this moment.
  adminSetupExpiresAt: string | null;
  // The signed-in admin granted it and may show the one-time password again.
  canViewOneTimePassword: boolean;
  // "Admin vergeben" asks for a one-time password (a WebUntis account).
  needsOneTimePassword: boolean;
  role: AccountRole;
  todoCount: number;
  createdAt: string;
  updatedAt: string;
  // Multi-school: the account's school, and what kind of admin it is.
  schoolId?: string | null;
  schoolName?: string | null;
  isUntisUser?: boolean;
  adminKind?: 'owner' | 'global' | 'school' | 'none' | null;
  adminGrants?: Array<{ scope: string; preset: string; schoolName: string | null }>;
  // Last sign-in to the apps (from the request logs; older ones are gone).
  lastSignInAt?: string | null;
  // Admins only: second factor and last panel login.
  adminSecurity?: AdminLoginSecurity | null;
}

export type FactorKind = 'totp' | 'passkey';

// An admin panel account's login security: the authenticator app is always
// required (ADMIN_REQUIRE_SECOND_FACTOR), a passkey when switched on for the
// account or, with passkeySource "default", by ADMIN_REQUIRE_PASSKEY.
export interface AdminLoginSecurity {
  totpRequired: boolean;
  passkeyRequired: boolean;
  passkeySource: 'account' | 'default';
  // Required but not set up yet.
  missing: FactorKind[];
  totp: boolean;
  passkeys: number;
  lastLoginAt: string | null;
  lastLoginMethod: string | null;
}

// "none": neither student nor parent, e.g. an admin outside any class.
export type AccountRole = 'student' | 'parent' | 'none';

export interface AdminTodo {
  id: string;
  title: string;
  details: string;
  dueAt: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
}

export interface AdminClassTodo extends AdminTodo {
  stableUid: string;
  username: string;
}

export interface AdminUserClass {
  classId: string;
  className: string;
  classCode: string;
  joinedAt: string;
}

export interface AdminUserDetail extends AdminUser {
  // Whether the account can sign in to the panel with its own password.
  hasPassword?: boolean;
  // False for an admin that has no password the panel accepts (an older
  // WebUntis admin) — "Einmal-Passwort vergeben" fixes that.
  adminCanSignIn: boolean;
  // A server owner (ADMIN_USERNAMES): managed in the .env, not in the panel.
  isOwner?: boolean;
  serverTime: string;
  todos: AdminTodo[];
  classes: AdminUserClass[];
}

export interface AdminStats {
  totalUsers: number;
  totalAdmins: number;
  totalClasses: number;
  totalTodos: number;
  totalReminders: number;
  totalActiveSessions: number;
  requestsToday: number;
  errorsToday: number;
  avgResponseTimeToday: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  serverUptime: number;
  usersByDay: Array<{ date: string; count: number }>;
}

export interface FileLogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
}

export interface FileLogFile {
  filename: string;
  date: string;
  size: number;
}

export interface FileLogResponse {
  entries: FileLogEntry[];
  total: number;
  page: number;
  limit: number;
  date: string;
}

export interface AdminReminder {
  id: string;
  classId: string;
  title: string;
  body: string;
  remindAt: string;
  createdBy: string;
  createdByName: string;
  createdByUsername: string;
  createdAt: string;
}

export interface AdminClass {
  id: string;
  name: string;
  code: string;
  webuntisKlasseId: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  memberCount: number;
  members: Array<{ stableUid: string; username: string; joinedAt: string }>;
}

/** "app" (phone app), "pwa" (website installed to the home screen), "web" (browser), "other". */
export type SessionClient = 'app' | 'pwa' | 'web' | 'other';

/** One signed-in device of a person (services/sessions.ts). */
export interface AdminSessionDevice {
  id: string;
  client: SessionClient;
  platform: string;
  os: string;
  browser: string;
  model: string;
  /** "Android · POKYH App 2.1.0" */
  label: string;
  ip: string | null;
  country: string;
  region: string | null;
  city: string | null;
  /** "Brixen, Trentino-Südtirol, IT"; "" when unknown. */
  place: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface AdminSessionPerson {
  stableUid: string;
  username: string;
  role: string;
  className: string;
  lastUsedAt: string;
  devices: AdminSessionDevice[];
}

export interface AdminSessionsResponse {
  people: AdminSessionPerson[];
  totals: { people: number; devices: number; byClient: Record<SessionClient, number> };
  /** Sign-ins per local day ("2026-10-24") of the last 14 days. */
  signInsPerDay: Record<string, number>;
  idleDays: number;
}

export interface AdminLoginEvent {
  id: string;
  at: string;
  method: 'webuntis' | 'office' | 'local' | 'register';
  client: SessionClient;
  label: string;
  ip: string | null;
  place: string;
}

export interface UsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  limit: number;
  pages?: number;
  // For countdowns that run against the server clock.
  serverTime: string;
}

export interface RequestLog {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  ip: string | null;
  stableUid: string | null;
  username: string | null;
  userAgent: string | null;
  error: string | null;
  requestId: string | null;
  scope: string | null;
  createdAt: string;
}

export interface LogsResponse {
  logs: RequestLog[];
  total: number;
  page: number;
  limit: number;
}

export interface UserLogsResponse extends LogsResponse {
  user: { username: string } | null;
}

export interface SetupStatus {
  needsSetup: boolean;
  ingressManagedExternally: boolean;
}

export interface RequestsChartPoint {
  hour: string;
  count: number;
  errors: number;
}

export interface TopEndpoint {
  path: string;
  count: number;
  avgMs: number;
}

export type DishPlan = 'summer' | 'winter';

export interface AdminDishFull {
  id: string;
  nameDe: string;
  nameIt: string;
  nameEn: string;
  descDe: string;
  descIt: string;
  descEn: string;
  imageUrl: string;
  category: string;
  tags: string[];
  prepTime: number;
  calories: number;
  price: number;
  protein: number;
  fat: number;
  allergens: string[];
  isVegetarian: boolean;
  isVegan: boolean;
  date: string;
  sortOrder: number;
  plan: DishPlan;
  stableKey?: string;
  weekOrdinal?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDishImportResult {
  imported: number;
  updated: number;
  total: number;
  plan: DishPlan;
}

export interface AdminDishShiftResult {
  shifted: number;
}

export interface AdminDishRotateResult {
  rotated: number;
}

export interface AdminDishResetResult {
  deleted: number;
  imported: number;
  plan: DishPlan;
}

export interface AdminDishAnchorResult {
  normalized: number;
  rotated: number;
  otherAligned: number;
  otherAnchorDate: string | null;
  otherRotated: number;
}

export interface AdminDishRatingEntry {
  stableUid: string;
  username: string;
  stars: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDish {
  dishId: string; // stableKey
  name: string;
  imageUrl: string;
  avgStars: number;
  count: number;
  plans: DishPlan[];
  ratings: AdminDishRatingEntry[];
}


export interface AdminSubjectImage {
  key: string;
  longName: string;
  shortName: string;
  hasImage: boolean;
  mimeType: string | null;
  updatedAt: string | null;
}

export interface AdminComment {
  id: string;
  type: 'reminder' | 'dish';
  stableUid: string;
  username: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  contextId: string;
  contextTitle: string;
  classId: string | null;
}

export interface AdminCommentsResponse {
  comments: AdminComment[];
  total: number;
  page: number;
  limit: number;
}

export interface FrontendActivityLog {
  id: string;
  event: string;
  page: string | null;
  detail: string | null;
  stableUid: string | null;
  username: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface FrontendActivityLogsResponse {
  logs: FrontendActivityLog[];
  total: number;
  page: number;
  limit: number;
}

export interface FrontendActivityStats {
  totalToday: number;
  uniqueUsersToday: number;
  eventBreakdown: Array<{ event: string; count: number }>;
  topPages: Array<{ page: string; count: number }>;
  // The dashboard's "today": active users as the Analytics page counts them,
  // and events and pages of today only (the two above reach 7 days and 24 h).
  activeUsersToday: number;
  eventsToday: Array<{ event: string; count: number }>;
  topPagesToday: Array<{ page: string; count: number }>;
}

export interface AdminAllTodo extends AdminTodo {
  stableUid: string;
  username: string;
  archivedAt: string | null;
}

export interface AllTodosResponse {
  todos: AdminAllTodo[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminAllReminder extends AdminReminder {
  className: string;
  archivedAt: string | null;
}

export interface AllRemindersResponse {
  reminders: AdminAllReminder[];
  total: number;
  page: number;
  limit: number;
}

// ── School year archive ───────────────────────────────────────────────────────

export interface SchoolYearMeta {
  id: string;
  label: string;
  startYear: number;
  rolledAt: string;
  note: string;
  createdAt: string;
}

export interface SchoolYearsResponse {
  current: { label: string; startYear: number };
  archived: SchoolYearMeta[];
}

export interface ArchivedUser {
  id: string;
  schoolYearId: string;
  stableUid: string;
  username: string;
  role: AccountRole;
  webuntisKlasseId: number;
  webuntisKlasseName: string;
  classId: string | null;
  classCode: string | null;
  className: string | null;
  createdAt: string;
  /** The account's school year in figures, when it was active (archived_activity). */
  activity: { activeDays: number; logins: number; activeSeconds: number } | null;
}

export interface ArchivedUsersResponse {
  users: ArchivedUser[];
  total: number;
  page: number;
  limit: number;
}

export interface ArchivedClassMember {
  stableUid: string;
  username: string;
  role: string;
  joinedAt: string;
}

export interface ArchivedClass {
  id: string;
  originalId: string;
  name: string;
  code: string;
  webuntisKlasseId: number;
  createdBy: string;
  createdByName: string;
  memberCount: number;
  members: ArchivedClassMember[];
  createdAt: string;
}

export interface ArchivedTodo {
  id: string;
  originalId: string;
  stableUid: string;
  username: string;
  title: string;
  details: string;
  dueAt: string | null;
  done: boolean;
  doneAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface ArchivedTodosResponse {
  todos: ArchivedTodo[];
  total: number;
  page: number;
  limit: number;
}

export interface ArchivedComment {
  id: string;
  stableUid: string;
  username: string;
  body: string;
  createdAt: string;
}

export interface ArchivedReminder {
  id: string;
  originalId: string;
  classId: string;
  className: string;
  title: string;
  body: string;
  remindAt: string;
  createdBy: string;
  createdByName: string;
  createdByUsername: string;
  archivedAt: string | null;
  comments: ArchivedComment[];
  createdAt: string;
}

export interface ArchivedRemindersResponse {
  reminders: ArchivedReminder[];
  total: number;
  page: number;
  limit: number;
}

export interface RolloverResult {
  ok: boolean;
  label: string;
  usersArchived: number;
  activityArchived?: number;
  classesArchived: number;
  todosArchived: number;
  remindersArchived: number;
}

export interface RollbackResult {
  ok: boolean;
  label: string;
  usersRestored: number;
  classesRestored: number;
  membersRestored: number;
  todosRestored: number;
  remindersRestored: number;
  commentsRestored: number;
}

export interface AdminApiKey {
  id: string;
  name: string;
  purpose: string;
  platform: string;
  scopes: string[];
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedApiKey extends AdminApiKey {
  key: string;
}

export interface LearnConfigValues {
  legalGateEnabled: boolean;
  legalGateReady: boolean;
  hasWebUntisAuthorizationReference: boolean;
  privacyNoticeUrl: string;
  privacyNoticeVersion: string;
  dictionaryEnabled: boolean;
  dictionaryProvider: string;
  dictionaryBaseUrl: string;
  dictionaryContactEmail: string;
  dictionaryAllowedPairs: string;
  dictionaryTimeoutMs: number;
  dictionaryCacheTtlMs: number;
  dictionaryMaxCacheEntries: number;
  dictionaryValidationEnabled: boolean;
  dictionaryValidationProvider: string;
  dictionaryValidationBaseUrl: string;
  dictionaryValidationTimeoutMs: number;
  dictionaryValidationCacheTtlMs: number;
  dictionaryValidationMaxCacheEntries: number;
  reviewInitialIntervalDays: number;
  reviewMaxIntervalDays: number;
  reviewMinimumEase: number;
  reviewMaximumEase: number;
  reviewCorrectEaseStep: number;
  reviewIncorrectEasePenalty: number;
  reviewWrongDelayMinutes: number;
  analyticsRetentionDays: number;
  importMaxCourses: number;
  importMaxSectionsPerCourse: number;
  importMaxVocabularyPerCourse: number;
}

// ── Learn AI vocabulary trainer administration ───────────────────────────────────
// Access is separate from this config: it always additionally requires a
// LearnAiGrant (personal) or LearnAiTeamGrant (team) below — `enabled` here
// is only the platform-wide kill-switch, never a substitute for a grant.
export interface LearnAiConfigValues {
  enabled: boolean;
  modelName: string;
  contextTokens: number;
  numPredictFast: number;
  rateLimitMessagesPerHour: number;
  maxConcurrentTrainingGenerations: number;
  ollamaBaseUrl: string;
  ollamaTimeoutMs: number;
}

export interface LearnAiGrant {
  stableUid: string;
  username: string;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  note: string;
}

export interface LearnAiTeamGrant {
  teamId: string;
  teamName: string;
  memberCount: number;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  note: string;
}

// ── Learn group administration ──────────────────────────────────────────────
// These values intentionally reflect the admin-only `/api/admin/learn/teams`
// response. It exposes membership and aggregate course counts, never course
// content, answer data, credentials, or API-key material.
export type LearnTeamRole = 'OWNER' | 'MANAGER' | 'MEMBER';
export type LearnTeamAssignableRole = Exclude<LearnTeamRole, 'OWNER'>;

export interface AdminLearnTeamMember {
  stableUid: string;
  role: LearnTeamRole;
  joinedAt: string;
  user: {
    username: string;
    isUntisUser: boolean;
  } | null;
}

export interface AdminLearnTeam {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  creator: { username: string } | null;
  memberCount: number;
  courseCount: number;
  members: AdminLearnTeamMember[];
}

// ── Learn course administration ─────────────────────────────────────────────
// The admin course surface carries operational metadata and explicit grants
// only. It intentionally does not expose lesson JSON, vocabulary/answer text,
// quiz attempts, or learner analytics.
export type LearnCourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type LearnCourseVisibility = 'PRIVATE' | 'TEAM' | 'PUBLIC';
export type LearnCoursePermission = 'VIEW' | 'EDIT' | 'MANAGE';

export interface AdminLearnCourseCounts {
  sections: number;
  vocabulary: number;
  enrollments: number;
  directAccess: number;
}

export interface AdminLearnCourse {
  id: string;
  slug: string;
  title: string;
  summary: string;
  subject: string;
  language: string;
  level: string;
  visibility: LearnCourseVisibility;
  status: LearnCourseStatus;
  coverImageUrl: string;
  ownerLocked: boolean;
  createdAt: string;
  updatedAt: string;
  creator: { username: string };
  team: { id: string; name: string } | null;
  counts: AdminLearnCourseCounts;
}

export interface AdminLearnCourseAccess {
  stableUid: string;
  permission: LearnCoursePermission;
  createdAt: string;
  updatedAt: string;
  user: {
    username: string;
    isUntisUser: boolean;
  };
}

export interface AdminLearnCoursesResponse {
  courses: AdminLearnCourse[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminLearnCourseAccessResponse {
  course: AdminLearnCourse;
  access: {
    items: AdminLearnCourseAccess[];
    total: number;
    page: number;
    limit: number;
  };
}

// ── Learn vocabulary list administration ────────────────────────────────────
// A "vocabulary list" is a Learn course's vocabulary entries. Unlike the
// learner-facing quiz surface, these admin views intentionally include the
// target-language translation — this is the admin's own authoritative view
// of curated content, not something a learner could read answers from.
export type LearnVocabularyVerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'FLAGGED';

export interface AdminLearnVocabularyEntry {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  targetText: string;
  article: string;
  partOfSpeech: string;
  notes: string;
  tags: string[];
  verificationStatus: LearnVocabularyVerificationStatus;
  verificationSource: string;
  createdAt: string;
  updatedAt: string;
  creator: { username: string };
}

export interface AdminLearnCourseVocabularyResponse {
  course: AdminLearnCourse;
  vocabulary: {
    items: AdminLearnVocabularyEntry[];
    total: number;
    page: number;
    limit: number;
  };
}

export type LearnVocabularyImportOutcome =
  | 'added'
  | 'synonym_added'
  | 'duplicate_exact'
  | 'duplicate_near_translation'
  | 'duplicate_near_source'
  | 'skipped_missing_translation';

export interface AdminLearnVocabularyImportResultItem {
  sourceText: string;
  targetText: string;
  outcome: LearnVocabularyImportOutcome;
  matchedExisting: { sourceText: string; targetText: string } | null;
  possibleTypoOf: string | null;
  dictionaryAdvisory: { translation: string; matchesIncoming: boolean } | null;
}

export interface AdminLearnVocabularyImportSummary {
  totalIncoming: number;
  added: number;
  synonymAdded: number;
  duplicateExact: number;
  duplicateNearTranslation: number;
  duplicateNearSource: number;
  skippedMissingTranslation: number;
}

export interface AdminLearnVocabularyImportResponse {
  course: AdminLearnCourse | null;
  summary: AdminLearnVocabularyImportSummary;
  results: AdminLearnVocabularyImportResultItem[];
}

export interface BackupFile {
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

export interface BackupsResponse {
  config: {
    enabled: boolean;
    scheduleHour: number;
    retentionDays: number;
    lastRunAt: string | null;
    lastRunStatus: string | null;
  };
  files: BackupFile[];
}

export type PopupPlatform = 'all' | 'web' | 'android';
export type PopupAudience = 'all' | 'users' | 'guests';
export type PopupMode = 'once' | 'recurring';
export type PopupStatus = 'disabled' | 'scheduled' | 'active' | 'expired';

export interface AdminPopup {
  id: string;
  title: string;
  content: string;
  contentHtml: string;
  platform: PopupPlatform;
  audience: PopupAudience;
  mode: PopupMode;
  showCount: number;
  startsAt: string | null;
  endsAt: string | null;
  slotMs: number | null;
  enabled: boolean;
  revision: number;
  status: PopupStatus;
  // Empty both: everybody the platform and audience allow.
  targetUsers: PopupTargetUser[];
  targetClasses: Array<{ id: number; name: string }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PopupTargetUser {
  stableUid: string;
  username: string;
  klasseName: string;
}

export interface PopupTargetClass {
  id: number;
  name: string;
  users: number;
}

export interface PopupInput {
  title: string;
  content: string;
  platform: PopupPlatform;
  audience: PopupAudience;
  mode: PopupMode;
  showCount: number;
  startsAt: string | null;
  endsAt: string | null;
  enabled: boolean;
  resetSeen?: boolean;
  targetUsers: string[];
  targetClasses: number[];
}

// ── Cluster (multi-node replication) ─────────────────────────────────────────

export type ClusterPeerState = 'PENDING' | 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'LOCKED' | 'REMOVED';
export type ClusterPeerHealth = 'UNKNOWN' | 'ONLINE' | 'SUSPECT' | 'OFFLINE';

export interface ClusterPeer {
  id: string;
  nodeId: string | null;
  name: string;
  address: string;
  status: ClusterPeerState;
  // HOST: this node invited (or was asked to wait for) the other; JOIN: this node joined.
  role: 'HOST' | 'JOIN';
  introducedBy: string | null;
  health: ClusterPeerHealth | null;
  lastSeenAt: string | null;
  latencyMs: number | null;
  clockSkewMs: number | null;
  pendingRows: number;
  fullTransfer: boolean;
  rowsSent: number;
  rowsReceived: number;
  lastSyncAt: string | null;
  lastError: string | null;
  schemaMatch: boolean | null;
  verify: { lastAt: string | null; repaired: number; running: boolean; error: string | null } | null;
  pairing: { expiresAt: string | null; failures: number; message: string } | null;
  knownPeers: Array<{ id: string; health: string }>;
  // The peer's pinned certificate on the mutually authenticated channel.
  tls: { pin: string; url: string | null; locked: boolean; active: boolean } | null;
  // Ways through the peer's web proxy, and whether calls use one right now.
  pathWays: string[];
  onPath: boolean;
  pathActive: string | null;
  warnings: string[];
  createdAt: string;
}

export type ClusterInstallState = 'OPEN' | 'PROVISIONED' | 'DONE' | 'EXPIRED' | 'LOCKED' | 'REVOKED';

export interface ClusterInstall {
  id: string;
  status: ClusterInstallState;
  // The new server's domain or IP as entered; empty: detected on install.
  address: string;
  web: InstallWebMode;
  name: string;
  withAi: boolean;
  failures: number;
  expiresAt: string;
  provisionedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type InstallWebMode = 'none' | 'domain' | 'proxy';

export interface InstallOptions {
  web: InstallWebMode;
  apiPort: number;
  apiBind: string;
  apiFrom: string[];
  clusterPort: number;
  clusterBind: string;
  clusterFrom: string[];
}

export interface CreatedClusterInstall {
  id: string;
  command: string;
  expiresAt: string;
  address: string;
  options: InstallOptions;
  name: string;
  pin: string;
  scriptSha256: string;
}

export interface ClusterScope {
  learn: boolean;
  source: 'env' | 'panel';
  changedAt: string | null;
  changedBy: string | null;
  learnTables: number;
  differing: string[];
}

export interface ClusterStatus {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  scope: ClusterScope;
  node: {
    id: string;
    name: string;
    advertiseUrl: string;
    advertiseFromEnv: boolean;
    schema: string | null;
    replicatedTables: number;
    captureReady: boolean;
    captureError: string | null;
    captureGap: boolean;
    deferredChanges: number;
    uptimeSeconds: number;
    workNodes: number;
    exclusiveJobsHere: boolean;
    verifyIntervalMinutes: number;
    inviteMinutes: number;
    installMinutes: number;
    aiEnabled: boolean;
    apiPort: number;
    clusterPort: number;
  };
  channel: {
    publicPath: boolean;
    port: number;
    bindAddress: string;
    listening: boolean;
    mtls: {
      port: number;
      bindAddress: string;
      listening: boolean;
      url: string | null;
      pin: string | null;
      certificateEnds: string | null;
    };
    allowlistEntries: number;
    autoMesh: boolean;
    warnings: string[];
  };
  peers: ClusterPeer[];
  events: Array<{ at: string; level: 'info' | 'warn' | 'error'; message: string }>;
}

// ── Cluster: how a node is reached, relays ──────────────────────────────────

export type ReachKind = 'direct' | 'proxy-port' | 'proxy-sni' | 'proxy-path';

export interface WayTestResult {
  ok: boolean;
  ms: number;
  message: string;
}

export interface ProxySnippets {
  nginx: string;
  haproxy: string;
  traefik: string;
  caddy: string;
}

export interface ReachEntry {
  id: string;
  kind: ReachKind;
  endpoint: string;
  enabled: boolean;
  backend: string;
  snippets?: ProxySnippets | null;
}

export interface ClusterRelay {
  id: string | null;
  pin: string;
  name: string;
  source: 'panel' | 'env';
  enabled: boolean;
  usePorts: boolean;
  useSni: boolean;
  route: string;
  domain: string;
  ports: string[];
  parked: number;
  handedOver: number;
  lastParkedAt: string | null;
  error: string | null;
  endpoints: string[];
  snippets: ProxySnippets | null;
}

export interface ClusterUpdateSettings {
  repo: string;
  branch: string;
  auto: boolean;
  requireCi: boolean;
  approvedCommit: string;
  source: 'panel' | 'env';
  updatedBy: string | null;
  updatedAt: string | null;
}

export type ClusterUpdateNodeState = 'done' | 'updating' | 'failed' | 'manual' | 'skipped' | 'waiting' | 'next';

export interface ClusterUpdates {
  settings: ClusterUpdateSettings;
  defaults: { pollMinutes: number; skipOfflineMinutes: number; healthTimeoutSeconds: number };
  upstream: {
    commit: string | null;
    checkedAt: string | null;
    error: string | null;
    ci: { state: 'success' | 'pending' | 'failure' | 'none' | 'unsupported' | 'error'; detail: string; commit: string } | null;
  };
  target: string | null;
  targetWhy: string;
  self: {
    nodeId: string;
    commit: string | null;
    builtAt: string | null;
    color: string | null;
    selfUpdating: boolean;
    updaterSeenAt: string | null;
    state: 'idle' | 'fetching' | 'requested' | 'preparing' | 'building' | 'starting' | 'switching' | 'done' | 'failed';
    message: string | null;
    failed: string | null;
    failedMessage: string | null;
    canRollBack: boolean;
  };
  nodes: Array<{ id: string; name: string; commit: string | null; selfUpdating: boolean; online: boolean; failed: string | null }>;
  decision: {
    action: 'none' | 'update' | 'wait' | 'blocked' | 'manual' | 'failed';
    reason: string;
    order: Array<{ id: string; name: string; state: ClusterUpdateNodeState }>;
  } | null;
}

export interface ClusterReach {
  port: number;
  listening: boolean;
  effective: string[];
  env: string[];
  envInvalid: string[];
  entries: ReachEntry[];
  relayEndpoints: string[];
  relayLabel: string;
  relays: ClusterRelay[];
  peers: Array<{ id: string; name: string; outgoing: string | null; incoming: string | null }>;
  // Ways through this node's web proxy (unpinned), and where they arrive.
  pathWays: string[];
  pathEnv: string[];
  pathEnvInvalid: string[];
  pathEntry: { apiPort: boolean; apiPortNumber: number; clusterPort: number };
}

// ─── Analytics (GET /api/admin/analytics) ───────────────────────────────────

// The last 7, 30, 90 or 365 days ("7" …), everything ("all"), or a calendar
// year ("2026").
export type AnalyticsRange = 'all' | `${number}`;
// The native apps on their own; everything in a browser (phone or computer,
// tab or installed PWA) is "web". "other" is an app that names no platform.
export type UsagePlatform = 'ios' | 'android' | 'web' | 'other';
export type PlatformCounts = Record<UsagePlatform, number>;

export interface AdminAnalytics {
  generatedAt: string;
  timezone: string;
  period: { key: string; label: string; fromKey: string; toKey: string };
  availableYears: number[];
  days: number;
  axis: string[];
  live: { online: number; byPlatform: PlatformCounts };
  platforms: {
    // "accounts": different accounts in the period; "dailyAverage": different
    // people per day, averaged (periods longer than the server logs reach).
    mode: 'accounts' | 'dailyAverage';
    total: number;
    byPlatform: PlatformCounts;
    multiPlatform: number;
    web: { mobile: number; desktop: number; pwa: number; browser: number };
    requestLogRetentionDays: number;
    visitRetentionDays: number;
  };
  time: {
    sessions: number;
    guestSessions: number;
    totalSeconds: number;
    avgSessionSeconds: number;
    medianSessionSeconds: number;
    longestSessionSeconds: number;
    avgDailySecondsPerUser: number;
    sessionsPerUserDay: number;
    screensPerSession: number;
    byPlatform: Record<UsagePlatform, { sessions: number; seconds: number; users: number }>;
    lengthBands: Array<{ label: string; sessions: number }>;
  };
  daily: Array<{
    dayKey: string;
    // Measured by the visit heartbeat (time is per these)…
    users: number;
    // …and active at all that day: visits, or the server logs where they
    // saw more.
    people: number;
    sessions: number;
    seconds: number;
    userSeconds: number;
    byPlatform: PlatformCounts;
    signups: number;
    // Website page views and different website visitors, signed in or not.
    webViews: number;
    webVisitors: number;
  }>;
  // Where the website and the apps are used from: website page views and app
  // openings by country, and their different addresses.
  origin: {
    views: number;
    appViews: number;
    ips: number;
    countries: number;
    byCountry: Array<{ country: string; views: number; visitors: number }>;
  };
  // Everyone on the website, signed in or not.
  web: {
    views: number;
    // Different visitors per day, added up: two days on the site count twice.
    visitors: number;
    guestViews: number;
    // "davon mit Konto": the same, opened signed in.
    signedViews: number;
    signedVisitors: number;
    // Different addresses — everyone's, signed in or not — in the part of the
    // period that still has them, and those from which someone signed in.
    ips: number;
    signedIps: number;
    countries: number;
    // Every known country, most views first.
    byCountry: Array<{ country: string; views: number; visitors: number }>;
    // The first day a website visit was recorded.
    since: string | null;
    ipRetentionDays: number;
  };
  hours: Array<{ hour: number; sessions: number; seconds: number }>;
  weekdays: Array<{ weekday: number; sessions: number; avgUsers: number; seconds: number }>;
  engagement: {
    dau: number;
    wau: number;
    mau: number;
    visitUsers: number;
    activeUsers: number;
    avgDau: number;
    stickiness: number | null;
    newUsers: number;
    returningUsers: number;
    loyalUsers: number;
    activeDaysPerUser: number;
  };
  accounts: {
    total: number;
    students: number;
    parents: number;
    noRole: number;
    untis: number;
    local: number;
    newInRange: number;
    withPush: number;
    withLearn: number;
    admins: number;
    classes: number;
    oldestDays: number;
    // Accounts that consented to the usage statistics.
    usageConsents: number;
    // Chose "Nur notwendige", and have not chosen yet.
    usageRefusals: number;
    usageUndecided: number;
  };
  features: {
    todos: number;
    todosDone: number;
    reminders: number;
    reminderComments: number;
    dishComments: number;
    dishRatings: number;
    avgStars: number | null;
    learnAnswers: number;
    learnCorrect: number;
    learnMinutes: number;
    learnLearners: number;
    pageViews: number;
    downloads: number;
  };
  mensa: {
    topRated: { name: string; avg: number; ratings: number } | null;
    mostRated: { name: string; ratings: number } | null;
    mostCommented: { name: string; comments: number } | null;
    starBands: number[];
  };
  // Anonymous class totals: `people` are person-days, `avgPeople` people per
  // day with use.
  classes: Array<{ name: string; seconds: number; sessions: number; people: number; avgPeople: number }>;
  // Sessions per app version and the different accounts behind it — null
  // when the period reaches back further than the server logs.
  appVersions: Array<{ platform: UsagePlatform; version: string; sessions: number; users: number | null }>;
  // Accounts that used an app without reporting a version (older app
  // versions). Null as above.
  appOlderUsers: { ios: number; android: number } | null;
  pages: Array<{ page: string; views: number; users: number }>;
}

// GET /api/admin/analytics/people — the accounts behind a figure.
export interface PeopleFilters {
  platform?: UsagePlatform;
  // One local day, YYYY-MM-DD.
  day?: string;
  hours?: number[];
  // 0 = Monday … 6 = Sunday.
  weekdays?: number[];
  klasse?: string;
  segment?: 'loyal' | 'multi' | 'new' | 'returning' | 'inactive' | 'consented';
  // A website page as the page list shows it ("/timetable").
  page?: string;
  // Accounts created on this local day, YYYY-MM-DD.
  created?: string;
  // Session-length band, the index into time.lengthBands.
  band?: number;
}

export interface AnalyticsPerson {
  stableUid: string;
  username: string;
  klasse: string;
  role: string;
  createdAt: string;
  seconds: number;
  // 0 when the account shows up only in the server logs.
  visits: number;
  activeDays: number;
  lastSeenAt: string | null;
  platforms: UsagePlatform[];
  // With a platform filter: app version, or for the web device and how it was opened.
  detail: string;
}

export interface AnalyticsPeople {
  days: number;
  total: number;
  // Matching accounts without usage-statistics consent: counted, never named.
  hidden: number;
  people: AnalyticsPerson[];
  // The days the list covers: visits name their account for a limited time
  // only, so a long period is cut to it ("clamped").
  window?: { fromKey: string; toKey: string; clamped: boolean };
}

// GET /api/admin/analytics/breakdown — what a "created" figure is made of.
export type BreakdownKind = 'todos' | 'reminders' | 'reminderComments' | 'downloads' | 'learn';

export interface AnalyticsBreakdown {
  kind: BreakdownKind;
  days: number;
  total: number;
  items: Array<{ label: string; value: number; note: string }>;
}

// GET /api/admin/analytics/dishes — every rated or commented dish.
export interface AnalyticsDish {
  key: string;
  name: string;
  lastServed: string;
  served: number;
  ratings: number;
  avgStars: number | null;
  // Ratings with 1 … 5 stars.
  stars: number[];
  comments: number;
}

export interface AnalyticsDishes {
  total: number;
  dishes: AnalyticsDish[];
}

// GET /api/admin/analytics/visitors — the visitors of the website and the
// apps by country and by address. Addresses are kept for `ipRetentionDays`
// only, so the address list covers `ipWindow`, the country figures the whole
// period. A view is a website page view or an app opening.
export type VisitorDevice = 'ios' | 'android' | 'desktop' | 'other';
// Which visits a visitor view shows.
export type VisitSource = 'all' | 'web' | 'app';
export type VisitClient = 'web' | 'app';

export interface VisitorCountry {
  // ISO 3166-1 alpha-2; "" for visits whose country is unknown.
  country: string;
  views: number;
  visitors: number;
  ips: number;
}

export interface VisitorIp {
  ip: string;
  country: string;
  region: string | null;
  city: string | null;
  views: number;
  // Of them app openings; the rest are website page views.
  appViews: number;
  days: number;
  firstAt: string | null;
  lastAt: string | null;
  devices: VisitorDevice[];
  // The website ("web") and the apps it was used in.
  platforms: UsagePlatform[];
  // Views made signed in: any at all makes the address "Konto", none "Gast".
  signedViews: number;
  // Different accounts signed in from the address (a school network puts many
  // behind one), and those with consent to the usage statistics by name.
  accountCount: number;
  accounts: Array<{ stableUid: string; username: string }>;
}

export interface AnalyticsVisitors {
  period: { key: string; label: string; fromKey: string; toKey: string };
  source: VisitSource;
  // Views in the period on the website and in the apps, whichever is shown.
  sources: Record<VisitClient, number>;
  totals: {
    views: number;
    visitors: number;
    guestViews: number;
    // "davon mit Konto".
    signedViews: number;
    signedVisitors: number;
    unknownViews: number;
    ips: number;
    signedIps: number;
    countries: number;
  };
  countries: VisitorCountry[];
  ips: VisitorIp[];
  ipWindow: { fromKey: string; toKey: string; clamped: boolean };
  ipRetentionDays: number;
  since: string | null;
}

// GET /api/admin/analytics/person — one consenting account across the page.
export interface AnalyticsPersonDetail {
  stableUid: string;
  username: string;
  klasse: string;
  createdAt: string;
  usage: {
    seconds: number;
    visits: number;
    activeDays: number;
    lastSeenAt: string | null;
    platforms: UsagePlatform[];
    daily: Array<{ dayKey: string; seconds: number }>;
    window: { fromKey: string; toKey: string; clamped: boolean };
  };
  // Where the account opened the website and the apps from.
  web: {
    // Website page views, and app openings beside them.
    views: number;
    appViews: number;
    ips: Array<{
      ip: string; country: string; region: string | null; city: string | null;
      views: number; appViews: number; platforms: UsagePlatform[]; lastAt: string | null;
    }>;
    pages: Array<{ page: string; views: number }>;
    window: { fromKey: string; toKey: string; clamped: boolean };
  };
}

// GET /api/admin/analytics/visitors/ip — one address in detail.
export interface AnalyticsVisitorIp {
  ip: string;
  country: string;
  region: string | null;
  city: string | null;
  views: number;
  // Of them app openings; the rest are website page views.
  appViews: number;
  days: number;
  firstAt: string | null;
  lastAt: string | null;
  signedInViews: number;
  // Different accounts signed in from it; those with consent to the usage
  // statistics by name.
  accountCount: number;
  accounts: Array<{ stableUid: string; username: string; klasse: string; views: number; appViews: number; lastAt: string | null }>;
  // Signed in without that consent: counted, never named.
  unnamedSignedInViews: number;
  daily: Array<{ dayKey: string; views: number }>;
  // Views per hour of the day, 0–23.
  hours: number[];
  // Website pages only.
  pages: Array<{ page: string; views: number }>;
  devices: Array<{ device: VisitorDevice; client: VisitClient; views: number }>;
  // `page` is "" and `appVersion` set for an app opening.
  recent: Array<{ at: string | null; client: VisitClient; page: string; appVersion: string | null; device: VisitorDevice; signedIn: boolean }>;
  window: { fromKey: string; toKey: string; clamped: boolean };
}

// ─── Admin login: second factor and passkeys ──────────────────────────────────

export interface SecondFactorChallenge {
  secondFactorRequired: true;
  ticket: string;
  // recovery: a recovery code works too (also where a passkey is required).
  methods: { totp: boolean; passkey: boolean; recovery?: boolean };
}

// After a one-time password: the new admin must choose their own password.
export interface PasswordSetupChallenge {
  passwordChangeRequired: true;
  ticket: string;
}

// secondFactorSetupRequired: signed in, but a second factor has to be set up
// before anything else opens.
export type LoginResult = { token: string; secondFactorSetupRequired?: boolean } | SecondFactorChallenge | PasswordSetupChallenge;

export interface PasskeyChallenge<O> {
  options: O;
  challengeToken: string;
}

export interface AdminPasskey {
  id: string;
  name: string;
  rpId: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AdminSecurityStatus {
  username: string;
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  passkeys: AdminPasskey[];
  // Which password signs this admin in: "admin" (panel only), "account" (also
  // the app login) or "config" (server configuration, not changeable here).
  password: 'admin' | 'account' | 'config';
  // What this account needs, and what it still has to set up.
  secondFactor?: { totpRequired: boolean; passkeyRequired: boolean; passkeySource: 'account' | 'default'; missing: FactorKind[]; setupPending: boolean };
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
}

// ─── Schools, permissions and administration ─────────────────────────────────

export type Permission = string;

export interface PermissionDef {
  key: Permission;
  group: string;
  scope: 'school' | 'global';
  action: 'read' | 'create' | 'update' | 'delete' | 'admin';
  label: string;
  description: string;
}

export interface PermissionPreset {
  key: string;
  label: string;
  description: string;
  scope: 'school' | 'global';
  permissions: Permission[];
  // Made in the panel (can be changed and removed), not built in.
  custom?: boolean;
  createdBy?: string | null;
  updatedAt?: string | null;
}

// A new or changed own preset.
export interface PresetDraft {
  label: string;
  description: string;
  scope: 'school' | 'global';
  permissions: Permission[];
}

export interface AccessCatalog {
  groups: Array<{ key: string; label: string }>;
  permissions: PermissionDef[];
  presets: PermissionPreset[];
}

export interface MeSchool {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  active: boolean;
  isDefault: boolean;
  menuId: string | null;
  permissions: Permission[];
}

export interface AdminMe {
  username: string;
  owner: boolean;
  timezone: string;
  hasAnyPermission: boolean;
  global: Permission[];
  globalView: boolean;
  schools: MeSchool[];
  // Something required is not set up yet: only setting it up opens.
  secondFactorSetupRequired?: boolean;
  secondFactorMissing?: FactorKind[];
}

export interface AdminSchool {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  webuntisSchool: string | null;
  webuntisBase: string;
  active: boolean;
  isDefault: boolean;
  // Joined on its first WebUntis sign-in, or the installation's own school.
  origin: 'webuntis' | 'installation';
  createdAt: string;
  updatedAt: string;
  users?: number;
  admins?: number;
  menu?: { id: string; name: string } | null;
}

export interface MensaMenu {
  id: string;
  name: string;
  isDefault: boolean;
  dishes: number;
  schools: Array<{ id: string; name: string }>;
  createdAt: string;
}

export interface AdminGrantView {
  scope: string;
  schoolName: string | null;
  preset: string;
  permissions: Permission[];
  grantedBy: string | null;
  updatedAt: string;
}

export interface AdminAccount {
  stableUid: string;
  username: string;
  schoolId: string | null;
  schoolName: string | null;
  owner: boolean;
  pending: boolean;
  setupExpiresAt: string | null;
  grants: AdminGrantView[];
  security: AdminLoginSecurity | null;
}

export interface GrantInput {
  scope: string;
  permissions: Permission[];
  preset?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  schoolId: string | null;
  schoolName: string | null;
  detail: Record<string, unknown>;
  requestId: string | null;
}

export interface AuditEventsResponse {
  events: AuditEvent[];
  total: number;
  page: number;
  limit: number;
  retentionDays: number;
}

// ─── Requests and monitoring ──────────────────────────────────────────────────

export type RequestScopeChoice = 'app' | 'core' | 'learn' | 'admin' | 'all';

export interface EndpointStat {
  endpoint: string;
  method: string;
  count: number;
  errors: number;
  serverErrors: number;
  avgMs: number;
  maxMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RequestsSummary {
  day: string;
  today: string;
  firstDay: string;
  scope: RequestScopeChoice;
  schoolId: string | null;
  totals: { count: number; clientErrors: number; serverErrors: number; avgMs: number; p50Ms: number | null; p95Ms: number | null };
  hours: Array<{ hour: number; count: number; clientErrors: number; serverErrors: number; avgMs: number }>;
  statuses: Array<{ status: number; count: number }>;
  endpoints: EndpointStat[];
  retentionDays: number;
}

export interface PerformanceReport {
  hours: number;
  endpoints: EndpointStat[];
  slowest: EndpointStat[];
  byScope: Array<{ scope: string; count: number; avgMs: number }>;
  buckets: number[];
}

export interface SystemHealth {
  process: { uptimeSeconds: number; node: string; rssMb: number; heapUsedMb: number; heapTotalMb: number };
  host: { cpus: number; loadAvg: number[]; freeMemMb: number };
  database: { ok: boolean; latencyMs: number | null; version: string | null; connections: number | null };
  lastFiveMinutes: { requests: number; serverErrors: number; avgMs: number };
}

export interface SystemLogEntry {
  timestamp: string | null;
  level: string | null;
  message: string;
  requestId: string | null;
  action: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  meta: Record<string, unknown>;
}

export interface SystemLogsResponse {
  entries: SystemLogEntry[];
  total: number;
  truncated: boolean;
  counts: Record<string, number>;
  page: number;
  limit: number;
}

export interface ClientErrorGroup {
  fingerprint: string;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  source: string | null;
  level: string | null;
  name: string;
  message: string;
  page: string;
  browser: string;
  release: string;
}

export interface ClientErrorOccurrence {
  id: string;
  at: string;
  source: string;
  level: string;
  name: string;
  message: string;
  stack: string | null;
  page: string;
  release: string;
  browser: string;
  requestId: string | null;
  schoolName: string | null;
}

// ─── Comments grouped by dish ─────────────────────────────────────────────────

export interface DishCommentGroup {
  dishId: string;
  name: string | null;
  imageUrl: string;
  deleted: boolean;
  comments: number;
  latestAt: string;
  ratingCount: number;
  avgStars: number | null;
}

export interface DishCommentGroupsResponse {
  dishes: DishCommentGroup[];
  total: number;
  page: number;
  limit: number;
  menuId: string | null;
  totalComments?: number;
}

export interface DishCommentItem {
  id: string;
  stableUid: string;
  username: string;
  body: string;
  stars: number | null;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
}

export interface DishCommentsResponse {
  dish: { dishId: string; name: string | null; imageUrl: string; deleted: boolean };
  comments: DishCommentItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ReminderCommentGroup {
  reminderId: string;
  title: string | null;
  className: string | null;
  remindAt: string | null;
  comments: number;
  latestAt: string | null;
}

export interface ReminderCommentItem {
  id: string;
  stableUid: string;
  username: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrivacyOverview {
  retention: Array<{ key: string; label: string; days: number | null; note: string }>;
  consents: { usageStats: number; refused: number; undecided: number; accounts: number };
  categories: Array<{ key: string; label: string; purpose: string; basis: string; retention: string; access: string }>;
  openPoints: Array<{ kind: 'code' | 'operational' | 'controller' | 'legal'; text: string }>;
}

// ─── Panel search (/api/admin/search) ───────────────────────────────────────

export type SearchKind = 'users' | 'classes' | 'admins' | 'dishes' | 'comments';

export interface SearchUser {
  id: string;
  username: string;
  role: string;
  className: string | null;
  local: boolean;
  admin: boolean;
  schoolId: string;
  schoolName: string | null;
}

export interface SearchClass {
  id: string;
  name: string;
  code: string;
  webuntisKlasseId: number;
  members: number;
  schoolId: string;
  schoolName: string | null;
}

export interface SearchAdmin {
  username: string;
  owner: boolean;
  global: boolean;
  schools: string[];
  schoolId: string;
  schoolName: string | null;
}

export interface SearchDish {
  id: string;
  name: string;
  key: string;
  plan: string;
  imageUrl: string | null;
  menuId: string | null;
  menuName: string | null;
  schoolIds: string[];
}

export interface SearchComment {
  id: string;
  type: 'dish' | 'reminder';
  body: string;
  username: string;
  context: string | null;
  dishKey: string | null;
  menuId: string | null;
  createdAt: string;
  schoolId: string;
  schoolName: string | null;
}

export interface SearchResponse {
  query: string;
  results: Partial<{
    users: { total: number; items: SearchUser[] };
    classes: { total: number; items: SearchClass[] };
    admins: { total: number; items: SearchAdmin[] };
    dishes: { total: number; items: SearchDish[] };
    comments: { total: number; items: SearchComment[] };
  }>;
}
