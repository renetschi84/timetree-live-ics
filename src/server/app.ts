import express from 'express';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { ExportJob, HealthPayload, RunState } from '@/lib/types';
import { maskIfToken } from '@/lib/health';
import { logger } from '@/lib/logger';
import { buildInfo } from '@/lib/version';

export function buildApp(
  jobs: ExportJob[],
  state: RunState,
  cronSchedule: string,
  outputDirs: string[],
  configPath?: string
) {
  const app = express();
  const resolvedOutputDirs = outputDirs.map((dir) => path.resolve(dir));
  const logOutputPaths = process.env.LOG_OUTPUT_PATHS === 'true';

  // Per-file basic auth based on config (runs before static)
  app.use((req, res, next) => {
    const requestedPath = req.path.split('?')[0];
    const stripped = requestedPath.replace(/^\/+/, '');

    let job: ExportJob | undefined;
    for (const dir of resolvedOutputDirs) {
      const candidate = path.resolve(dir, stripped);
      const dirPrefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
      if (!candidate.startsWith(dirPrefix)) continue; // prevent path traversal

      const match = jobs.find((j) => {
        const main = path.resolve(j.outputPath);
        const birthdays = j.birthdaysOutput ? path.resolve(j.birthdaysOutput) : null;
        const memos = j.memosOutput ? path.resolve(j.memosOutput) : null;
        return candidate === main || candidate === birthdays || candidate === memos;
      });
      if (match) {
        job = match;
        break; // respect static directory order
      }
    }

    if (!job || !job.auth) return next();

    if (job.auth.type === 'basic') {
      const header = req.headers.authorization;
      if (!header || !header.toLowerCase().startsWith('basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="ICS"');
        return res.status(401).send('Authentication required');
      }
      const [, encoded] = header.split(' ');
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const [user, pass] = decoded.split(':');
      if (user === job.auth.username && pass === job.auth.password) {
        return next();
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="ICS"');
      return res.status(401).send('Invalid credentials');
    }

    return next();
  });

  for (const dir of outputDirs) {
    app.use(express.static(dir));
  }
app.get('/loxone', async (_req, res) => {
  try {
    const fs = await import('node:fs/promises');

    let ics = '';

    for (const dir of resolvedOutputDirs) {
      try {
        ics = await fs.readFile(path.resolve(dir, 'timetree.ics'), 'utf8');
        if (ics) break;
      } catch {
        // try next output directory
      }
    }

    if (!ics) {
      return res.status(404).send('ERROR=NO_CALENDAR');
    }

    // Gefaltete ICS-Zeilen zusammenführen
    ics = ics.replace(/\r?\n[ \t]/g, '');

    const events = ics
      .split('BEGIN:VEVENT')
      .slice(1)
      .map((block) => {
        const summary =
          block.match(/\r?\nSUMMARY:(.*)/)?.[1]?.trim() ?? '';

        const start =
          block.match(/\r?\nDTSTART[^:]*:(\d{8}T?\d{0,6}Z?)/)?.[1] ?? '';

        const end =
          block.match(/\r?\nDTEND[^:]*:(\d{8}T?\d{0,6}Z?)/)?.[1] ?? '';

        return { summary, start, end };
      })
      .filter((event) => event.start);

    const nowVienna = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Vienna',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .replace(/[- :]/g, '');

    const normalize = (value: string) =>
      value.replace('T', '').replace('Z', '').padEnd(14, '0');

    const upcoming = events
      .filter((event) => normalize(event.end || event.start) >= nowVienna)
      .sort((a, b) =>
        normalize(a.start).localeCompare(normalize(b.start)),
      );
const nextNachtdienst = upcoming.find((event) => (event.summary || '').toLowerCase().includes('nachtdienst'));
    const next = upcoming[0];

    if (!next) {
      return res.type('text/plain').send(
        'NEXT_FOUND=0\nACTIVE=0',
      );
    }

    const s = normalize(next.start);
    const e = normalize(next.end || next.start);

    const active =
      nowVienna >= s && nowVienna <= e ? 1 : 0;

    const title = next.summary
      .replace(/\r/g, '')
      .replace(/\n/g, ' ')
      .replace(/=/g, '-');
const ns = nextNachtdienst ? normalize(nextNachtdienst.start) : '';
    res.type('text/plain').send(
      [
        'NEXT_FOUND=1',
        `TITLE=${title}`,
        `DATE=${s.substring(0, 8)}`,
        `HOUR=${s.substring(8, 10)}`,
        `MINUTE=${s.substring(10, 12)}`,
        `ACTIVE=${active}`,
        `NACHTDIENST_FOUND=${nextNachtdienst ? 1 : 0}`,
`NACHTDIENST_DATE=${ns ? ns.substring(0, 8) : 0}`,
`NACHTDIENST_HOUR=${ns ? ns.substring(8, 10) : 0}`,
      ].join('\n'),
    );
  } catch (error) {
    res.status(500).type('text/plain').send('ERROR=1');
  }
});
  app.get('/health', (_req, res) => {
    const payload: HealthPayload = {
      status: state.lastError ? 'degraded' : 'ok',
      lastRun: state.lastRun?.toISOString() ?? null,
      lastSuccess: state.lastSuccess?.toISOString() ?? null,
      lastError: state.lastError ?? null,
      running: state.running,
      schedule: cronSchedule,
      version: buildInfo.version,
    };

    // Log detailed info (masked tokens) without returning it
    const details = {
      outputs: jobs.map(maskIfToken),
      jobs: jobs.map((job) => ({
        id: job.id,
        email: job.email,
        calendarCode: job.calendarCode ?? null,
        outputPath: maskIfToken(job),
        lastRun: state.jobs[job.id].lastRun?.toISOString() ?? null,
        lastSuccess: state.jobs[job.id].lastSuccess?.toISOString() ?? null,
        lastError: state.jobs[job.id].lastError ?? null,
        running: state.jobs[job.id].running,
      })),
    };
    logger.debug({ details }, 'Health detail');

    res.json(payload);
  });

  app.get('/version', (_req, res) => {
    res.json(buildInfo);
  });

  // Logging
  if (configPath) logger.info(`Config path: ${configPath}`);
  logger.info('Outputs:');
  for (const job of jobs) {
    logger.info(`- ${logOutputPaths ? job.outputPath : maskIfToken(job)}`);
  }

  return app;
}
