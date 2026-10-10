import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SteamError } from './steam.mjs';

export function mergeSparkScores(profile, rows) {
  const relevant = rows.filter(row => String(row.steamid) === profile.player.steamid);
  const index = new Map(relevant.map(row => [row.tag, row]));
  if (index.size !== profile.tags.length) throw new SteamError('spark_mismatch', 'Spark 与页面画像的标签集合不一致。', 500);
  for (const tag of profile.tags) {
    const row = index.get(tag.id);
    if (!row) throw new SteamError('spark_mismatch', 'Spark 结果缺少标签。', 500);
    for (const metric of ['rawScore', 'share', 'score']) {
      if (!Number.isFinite(row[metric]) || Math.abs(row[metric] - tag[metric]) > 1e-8) {
        throw new SteamError('spark_mismatch', 'Spark 与参考算法的计算结果不一致。', 500);
      }
      tag[metric] = row[metric];
    }
  }
  profile.tags.sort((a, b) => b.rawScore - a.rawScore || a.id.localeCompare(b.id));
  profile.dimensions = profile.dimensions.map(d => ({ ...d, score: profile.tags.filter(t => t.dimension === d.id).reduce((sum, t) => sum + t.share, 0) * 100 }));
  profile.method.computeEngine = 'Apache Spark local[2]';
  profile.method.referenceVerification = '通过 Node 参考实现核对，误差阈值 1e-8';
  return profile;
}
export async function runSparkProfile(root, jobId, player, catalog, profile, progress) {
  const python = process.env.STEAM_ATLAS_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  try { await access(python); }
  catch { throw new SteamError('spark_unavailable', '未找到项目 Python 环境，请按 pipeline/README.md 安装 PySpark，或将 PROFILE_ENGINE 设为 node。', 503); }
  // Resolve a usable Java home without changing the user's global environment.
  const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
  let javaHome = process.env.STEAM_ATLAS_JAVA_HOME || process.env.JAVA_HOME;
  try { await access(path.join(javaHome || '', 'bin', javaName)); }
  catch {
    javaHome = undefined;
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
      try { await access(path.join(entry, javaName)); javaHome = path.dirname(entry); break; } catch {}
    }
  }
  if (!javaHome) throw new SteamError('spark_unavailable', '未找到 Java，请安装 Java 17 并加入 PATH。', 503);
  const work = path.join(root, 'pipeline', 'output', 'jobs', jobId);
  await mkdir(work, { recursive: true });
  const behaviors = path.join(work, 'behaviors.jsonl'), metadata = path.join(work, 'catalog.jsonl');
  const records = player.games.map(g => ({ steamid: player.steamid, appid: g.appid, playtime_forever: g.playtime_forever, tags: g.tags || [] }));
  await writeFile(behaviors, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const requiredApps=new Set(player.games.map(g=>Number(g.appid)));
  const sparkCatalog=catalog.reference?catalog.games.filter(g=>requiredApps.has(Number(g.appid))):catalog.games;
  await writeFile(metadata, sparkCatalog.map(g => JSON.stringify(g)).join('\n') + '\n');
  const referenceFile=path.join(work,'reference.json');
  if(catalog.reference) await writeFile(referenceFile,JSON.stringify({catalogTaggedGames:catalog.reference.catalogTaggedGames,frequencies:catalog.reference.frequencies}));
  progress({ stage: 'analyzing', message: '正在使用 Apache Spark 计算画像并写入 Parquet…', completed: 0, total: 0 });
  await new Promise((resolve, reject) => {
    const localFs = path.join(root, 'pipeline', 'output', 'windows-local-fs.jar');
    const referenceArgs=catalog.reference?['--reference-index',referenceFile]:[];
    const localFsArgs = process.platform === 'win32' ? ['--windows-local-fs', localFs] : [];
    const child = spawn(python, [path.join(root, 'pipeline', 'spark_batch.py'), ...localFsArgs, ...referenceArgs, '--behaviors', behaviors, '--catalog', metadata, '--output', path.join(work, 'result'), '--master', 'local[2]', '--partitions', '2', '--driver-json', '--weight-mode', profile.method.weightMode || 'balanced'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STEAM_API_KEY: '', JAVA_HOME: javaHome, PYSPARK_PYTHON: python, PYSPARK_DRIVER_PYTHON: python, SPARK_LOCAL_IP: '127.0.0.1' }
    });
    // No API key is passed in argv or outputs. Bound output to avoid memory growth.
    let logs = '';
    child.stdout.on('data', data => { logs = (logs + data).slice(-4000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
    const timeout = setTimeout(() => { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill(); reject(new SteamError('spark_timeout', 'Spark 计算超时，请检查本机资源和 Java 环境。', 504)); }, 180000);
    child.on('error', () => { clearTimeout(timeout); reject(new SteamError('spark_unavailable', '无法启动 Spark，请检查项目 Python 环境。', 503)); });
    child.on('close', async code => { clearTimeout(timeout); await writeFile(path.join(work, 'spark-log.txt'), logs).catch(() => {}); code === 0 ? resolve() : reject(new SteamError('spark_failed', 'Spark 批处理失败，请按 pipeline/README.md 检查运行环境。', 500)); });
  });
  const rows = JSON.parse(await readFile(path.join(work, 'result', 'profiles.json'), 'utf8'));
  const run = JSON.parse(await readFile(path.join(work, 'result', 'run.json'), 'utf8'));
  profile = mergeSparkScores(profile, rows);
  profile.method.sparkRun = run;
  return profile;
}

