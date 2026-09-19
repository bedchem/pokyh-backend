import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { learnAiLimiter } from '../middleware/rateLimiter';
import { ensureLearnProfile, learnAudit } from './learn';
import { hasActiveAiGrant, requireAiPilotAccess } from '../services/learnAiAccess';
import { getLearnAiConfig } from '../services/learnAiConfig';
import { isModelReady } from '../services/learnAiOllama';
import {
  createConversation,
  deleteConversation,
  getConversationMessages,
  listConversations,
  sendMessage,
} from '../services/learnAiConversations';

// A separate router from learn.ts (rather than growing that already-large,
// actively-shared file — see AGENTS.md's "Active shared areas") mounted at
// /learn/ai in src/routes/index.ts, ahead of the general /learn mount so it
// is matched first.
const router = Router();

router.use(requireAuth, learnAiLimiter);

router.get('/access', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const [hasGrant, aiConfig] = await Promise.all([hasActiveAiGrant(stableUid), getLearnAiConfig()]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    hasAccess: hasGrant && aiConfig.enabled,
    modelReady: isModelReady(),
    rateLimitMessagesPerHour: aiConfig.rateLimitMessagesPerHour,
    uploadsEnabled: aiConfig.uploadsEnabled,
  });
});

router.get('/conversations', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const conversations = await listConversations(stableUid);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ conversations });
});

router.post('/conversations', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const conversation = await createConversation(stableUid);
  learnAudit(req, 'ai_conversation_created', { conversationId: conversation.id });
  res.status(201).json({ conversation });
});

const conversationIdSchema = z.object({ id: z.string().uuid() });

router.get('/conversations/:id', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const { id } = conversationIdSchema.parse(req.params);
  const messages = await getConversationMessages(stableUid, id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ messages });
});

router.delete('/conversations/:id', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const { id } = conversationIdSchema.parse(req.params);
  await deleteConversation(stableUid, id);
  learnAudit(req, 'ai_conversation_deleted', { conversationId: id });
  res.status(204).end();
});

// Base64 inflates size by ~33%; 6MB comfortably covers the largest accepted
// upload (LearnAiConfig.uploadMaxBytes, 4MB by default) with headroom. The
// real byte-size enforcement happens in learnAiUploads.ts against the
// decoded buffer — this is just an outer sanity bound so an oversized
// payload is rejected by Zod before any decoding work happens.
const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  dataBase64: z.string().min(1).max(6_000_000),
});

const sendMessageSchema = z.object({
  content: z.string().max(4_000),
  idempotencyKey: z.string().min(1).max(100).optional(),
  attachments: z.array(attachmentSchema).max(3).optional(),
  // The current page the learner is looking at, so the assistant can help
  // explain it — never anything beyond a route path and page title (never
  // raw DOM/screen content), and always treated as untrusted reference
  // material by the model, never an instruction (see the system prompt in
  // learnAiConversations.ts).
  pageContext: z.object({
    path: z.string().max(300).optional().default(''),
    title: z.string().max(300).optional().default(''),
  }).optional(),
});

router.post('/conversations/:id/messages', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const { id } = conversationIdSchema.parse(req.params);
  const body = sendMessageSchema.parse(req.body);
  const result = await sendMessage(stableUid, id, body.content, body.idempotencyKey, body.attachments, body.pageContext);
  // Never the message content, attachment content, or page context itself —
  // only outcome metadata, per this repo's learnAudit() rule.
  learnAudit(req, 'ai_message_sent', {
    conversationId: id,
    mode: result.assistantMessage.mode,
    promptTokens: result.assistantMessage.promptTokens,
    completionTokens: result.assistantMessage.completionTokens,
    attachmentCount: result.userMessage.attachments.length,
  });
  res.status(201).json(result);
});

export { router as learnAiRouter };
