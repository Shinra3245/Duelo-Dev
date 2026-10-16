import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, getMatchLanguage, type CreateSubmissionRequest } from '@duelodev/shared';
import { createApp } from '../src/app.js';
import { InMemoryJudgeQueue } from '../src/queue/memory.js';
import { validateCreateRoomRequest } from '../src/schemas/rooms.js';

const config = {
  mode: 'puntos' as const,
  max_players: 3,
  num_problems: 1,
  categories: ['facil' as const],
  time_per_problem_s: 60,
};

describe('lenguaje único por sala', () => {
  it('interpreta como Python una configuración histórica y rechaza lenguajes desconocidos', () => {
    expect(getMatchLanguage(config)).toBe('python');
    for (const language of ['javascript', '', null, 42]) {
      expect(validateCreateRoomRequest({ config: { ...config, language } }).ok).toBe(false);
    }
  });

  it.each(LANGUAGES)(
    'persiste %s y rechaza otros lenguajes sin gastar cooldown',
    async (language) => {
      const queue = new InMemoryJudgeQueue();
      const app = createApp({ authSecret: 'room-language-tests-only', judgeQueue: queue });
      await app.start(0, '127.0.0.1');
      try {
        const host = await app.ctx.userRepo.create({ gamertag: `host-${language}`, role: 'user' });
        const created = await app.ctx.roomService.createRoom(host.id, {
          config: { ...config, language },
        });
        expect(created.config.language).toBe(language);
        expect((await app.ctx.roomRepo.findMatchById(created.match_id))?.config.language).toBe(
          language,
        );
        await app.ctx.roomRepo.updateMatch(created.match_id, { status: 'running' });

        const problem = await app.ctx.problemRepo.createProblem({
          id: randomUUID(),
          title: 'Prueba de lenguaje',
          description: 'Entrada y salida estándar',
          category: 'facil',
          time_limit_ms: 1000,
          memory_limit_mb: 256,
          version: 1,
          content_hash: 'language-test',
          created_at: new Date().toISOString(),
        });
        const submission: CreateSubmissionRequest = {
          match_id: created.match_id,
          round_id: randomUUID(),
          problem_id: problem.id,
          language,
          source_code: 'fixture que sólo se encola, nunca se ejecuta',
        };
        await expect(
          app.ctx.submissionService.submit(host.id, {
            ...submission,
            language: language === 'python' ? 'cpp' : 'python',
          }),
        ).rejects.toMatchObject({ statusCode: 400, code: 'UNSUPPORTED_LANGUAGE' });
        expect(queue.count()).toBe(0);
        expect(await app.ctx.submissionRepo.findSubmissionsByMatch(created.match_id)).toHaveLength(
          0,
        );

        const accepted = await app.ctx.submissionService.submit(host.id, submission);
        const job = queue.findBySubmissionId(accepted.response.submission_id)!.job;
        expect(job.language).toBe(language);
        expect(job.time_limit_ms).toBe(
          language === 'python' ? 3000 : language === 'java' ? 2000 : 1000,
        );
        const audit = await app.ctx.eventRepo!.findEventsByName('submission');
        expect(audit[0]?.payload).toMatchObject({ language });
      } finally {
        await app.close();
      }
    },
  );
});
