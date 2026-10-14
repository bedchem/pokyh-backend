export interface AdminUser {
  stableUid: string;
  username: string;
  webuntisKlasseId: number | null;
  webuntisKlasseName: string | null;
  classId: string | null;
  classCode: string | null;
  isAdmin: boolean;
  role: 'student' | 'parent';
  todoCount: number;
  createdAt: string;
  updatedAt: string;
}

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

export interface AdminSession {
  id: string;
  stableUid: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
}

export interface UsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  limit: number;
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
  role: 'student' | 'parent';
  webuntisKlasseId: number;
  webuntisKlasseName: string;
  classId: string | null;
  classCode: string | null;
  className: string | null;
  createdAt: string;
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

export type AnalyticsRange = 7 | 30 | 90;
// The native apps on their own; everything in a browser (phone or computer,
// tab or installed PWA) is "web". "other" is an app that names no platform.
export type UsagePlatform = 'ios' | 'android' | 'web' | 'other';
export type PlatformCounts = Record<UsagePlatform, number>;

export interface AdminAnalytics {
  generatedAt: string;
  timezone: string;
  days: number;
  axis: string[];
  live: { online: number; byPlatform: PlatformCounts };
  platforms: {
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
    users: number;
    sessions: number;
    seconds: number;
    userSeconds: number;
    byPlatform: PlatformCounts;
    signups: number;
  }>;
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
  classes: Array<{ name: string; seconds: number; users: number; sessions: number }>;
  appVersions: Array<{ platform: UsagePlatform; version: string; users: number }>;
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
  segment?: 'loyal' | 'multi' | 'new' | 'returning' | 'inactive';
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
