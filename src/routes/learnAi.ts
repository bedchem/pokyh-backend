import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/auth';
import { learnAiLimiter } from '../middleware/rateLimiter';
import { ensureLearnProfile, learnAudit } from './learn';
import { requireAiPilotAccess } from '../services/learnAiAccess';
import { checkTrainingSentence, generateTrainingSentence } from '../services/learnAiTrainer';

// AI is deliberately restricted to one vocabulary-training workflow. There
// are no conversation, free-text chat, attachment, history, or page-context
// routes: every model request starts from a server-authorized vocabulary entry.
const router = Router();

router.use(requireAuth, learnAiLimiter);

const sentenceRequestSchema = z.object({
  entryId: z.string().uuid(),
  direction: z.enum(['SOURCE_TO_TARGET', 'TARGET_TO_SOURCE']),
});

router.post('/training/sentences', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const body = sentenceRequestSchema.parse(req.body);
  const sentence = await generateTrainingSentence(stableUid, body.entryId, body.direction);
  learnAudit(req, 'ai_training_sentence_generated', {
    entryId: body.entryId,
    direction: body.direction,
    promptId: sentence.promptId,
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(201).json({ sentence });
});

const sentenceCheckSchema = z.object({
  answer: z.string().trim().min(1).max(900),
});

router.post('/training/sentences/:promptId/check', async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireAiPilotAccess(stableUid);
  const promptId = z.string().uuid().parse(req.params['promptId']);
  const body = sentenceCheckSchema.parse(req.body);
  const result = await checkTrainingSentence(stableUid, promptId, body.answer);
  learnAudit(req, 'ai_training_sentence_checked', { promptId, correct: result.correct });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(result);
});

export { router as learnAiRouter };
