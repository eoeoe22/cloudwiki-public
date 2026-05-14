#!/usr/bin/env node
// CloudWiki 대화형 설치 스크립트
// 실행: node scripts/setup.mjs  또는  npm run setup
//
// `wrangler example.toml` 을 템플릿으로 사용해 사용자 입력값으로 채워진
// `wrangler.toml` 을 생성한다. 선택에 따라 wrangler CLI 로 D1/R2/KV 리소스를
// 자동 생성하고 VAPID 키도 만들어둔다.

import { readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = resolve(ROOT, 'wrangler example.toml');
const OUTPUT_PATH = resolve(ROOT, 'wrangler.toml');

const rl = createInterface({ input, output });

let cancelled = false;
function handleCancel() {
  if (cancelled) return;
  cancelled = true;
  console.log('');
  console.log(`${C.yellow}!${C.reset} 사용자가 취소했습니다. wrangler.toml 은 변경되지 않았습니다.`);
  rl.close();
  process.exit(130);
}
rl.on('SIGINT', handleCancel);
process.on('SIGINT', handleCancel);

// ─────────────────────────────────────────────────────────────────────
// 입력 헬퍼
// ─────────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function header(text) {
  console.log('');
  console.log(`${C.cyan}${C.bold}━━━ ${text} ━━━${C.reset}`);
}

function info(text) {
  console.log(`${C.dim}${text}${C.reset}`);
}

function ok(text) {
  console.log(`${C.green}✓${C.reset} ${text}`);
}

function warn(text) {
  console.log(`${C.yellow}!${C.reset} ${text}`);
}

function err(text) {
  console.log(`${C.red}✗${C.reset} ${text}`);
}

async function ask(question, { def = '', validate } = {}) {
  const suffix = def ? ` ${C.dim}(${def})${C.reset}` : '';
  while (true) {
    const raw = (await rl.question(`${C.bold}?${C.reset} ${question}${suffix}: `)).trim();
    const value = raw || def;
    if (validate) {
      const result = validate(value);
      if (result !== true) {
        err(typeof result === 'string' ? result : '잘못된 입력입니다.');
        continue;
      }
    }
    return value;
  }
}

async function askYesNo(question, { def = 'y' } = {}) {
  const choices = def === 'y' ? 'Y/n' : 'y/N';
  while (true) {
    const raw = (await rl.question(`${C.bold}?${C.reset} ${question} ${C.dim}(${choices})${C.reset}: `)).trim().toLowerCase();
    const value = raw || def;
    if (value === 'y' || value === 'yes') return true;
    if (value === 'n' || value === 'no') return false;
    err('y 또는 n 으로 답해주세요.');
  }
}

async function askChoice(question, choices, { def } = {}) {
  console.log(`${C.bold}?${C.reset} ${question}`);
  choices.forEach((c, i) => {
    const marker = def !== undefined && def === i ? `${C.green}*${C.reset}` : ' ';
    console.log(`  ${marker} ${i + 1}) ${c.label}${c.hint ? ` ${C.dim}— ${c.hint}${C.reset}` : ''}`);
  });
  while (true) {
    const raw = (await rl.question(`  선택 ${def !== undefined ? C.dim + `(${def + 1})` + C.reset : ''}: `)).trim();
    const value = raw || (def !== undefined ? String(def + 1) : '');
    const n = parseInt(value, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
    err(`1~${choices.length} 중에서 선택해주세요.`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// wrangler CLI 헬퍼
// ─────────────────────────────────────────────────────────────────────

function runWrangler(args) {
  const res = spawnSync('npx', ['--yes', 'wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function isWranglerLoggedIn() {
  const res = spawnSync('npx', ['--yes', 'wrangler', 'whoami'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) return false;
  const out = (res.stdout + res.stderr).toLowerCase();
  return !out.includes('not authenticated') && !out.includes('not logged in');
}

function isContainerEnv() {
  // Docker, Codespaces, Gitpod, devcontainer 등 원격/컨테이너 환경 감지
  const envFlags = ['CODESPACES', 'GITPOD_WORKSPACE_ID', 'REMOTE_CONTAINERS', 'DEVCONTAINER'];
  if (envFlags.some(k => process.env[k])) return true;
  if (existsSync('/.dockerenv')) return true;
  return false;
}

function runWranglerLogin() {
  const res = spawnSync('npx', ['--yes', 'wrangler', 'login'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return res.status === 0;
}

function extractD1Id(stdout) {
  // wrangler 출력에서 database_id = "..." 또는 "id": "..." 패턴 추출
  const m = stdout.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)
    || stdout.match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/i)
    || stdout.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return m ? m[1] : null;
}

function extractKvId(stdout) {
  const m = stdout.match(/id\s*=\s*"([0-9a-f]{32})"/i)
    || stdout.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)
    || stdout.match(/\b([0-9a-f]{32})\b/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────
// VAPID 생성
// ─────────────────────────────────────────────────────────────────────

function toB64Url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateVapid() {
  const { subtle } = webcrypto;
  const kp = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const rawPub = await subtle.exportKey('raw', kp.publicKey);
  const jwkPriv = await subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: toB64Url(rawPub), privateKey: jwkPriv.d };
}

// ─────────────────────────────────────────────────────────────────────
// TOML 문자열 치환 헬퍼
// ─────────────────────────────────────────────────────────────────────

function escapeTomlBasic(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// 첫 줄의 `name = "cloudwiki"` 처럼 단일 키를 교체
function setSingleKey(tpl, key, value) {
  const re = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, 'm');
  if (!re.test(tpl)) {
    throw new Error(`키 ${key} 를 템플릿에서 찾을 수 없습니다.`);
  }
  return tpl.replace(re, `$1"${escapeTomlBasic(value)}"`);
}

// `[[d1_databases]]` 블록 안의 특정 키 교체 등을 위해, 섹션을 한정해서 치환
function setKeyInSection(tpl, sectionHeader, key, value) {
  const idx = tpl.indexOf(sectionHeader);
  if (idx === -1) throw new Error(`섹션 ${sectionHeader} 를 찾을 수 없습니다.`);
  const after = tpl.indexOf('[', idx + sectionHeader.length);
  const end = after === -1 ? tpl.length : after;
  const before = tpl.slice(0, idx);
  const block = tpl.slice(idx, end);
  const rest = tpl.slice(end);
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"`, 'm');
  if (!re.test(block)) throw new Error(`섹션 ${sectionHeader} 안에서 ${key} 를 찾을 수 없습니다.`);
  return before + block.replace(re, `$1"${escapeTomlBasic(value)}"`) + rest;
}

// ─────────────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.magenta}${C.bold}`);
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║       CloudWiki 대화형 설치 스크립트         ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log(C.reset);
  info('wrangler example.toml 을 기반으로 wrangler.toml 을 생성합니다.');
  info('도중에 종료하려면 Ctrl+C 를 누르세요. 기본값은 Enter 로 선택합니다.');

  // 템플릿 로드
  let template;
  try {
    template = await readFile(TEMPLATE_PATH, 'utf8');
  } catch (e) {
    err(`템플릿 파일을 읽을 수 없습니다: ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  // 기존 wrangler.toml 확인
  let outputExists = false;
  try { await access(OUTPUT_PATH); outputExists = true; } catch {}
  if (outputExists) {
    warn('기존 wrangler.toml 이 이미 존재합니다.');
    const overwrite = await askYesNo('백업(.bak) 후 새로 작성할까요?', { def: 'y' });
    if (!overwrite) {
      info('취소했습니다.');
      rl.close();
      return;
    }
    const bak = OUTPUT_PATH + '.bak';
    await copyFile(OUTPUT_PATH, bak);
    ok(`기존 파일을 ${bak} 로 백업했습니다.`);
  }

  // ── 1. 기본 정보 ─────────────────────────────────────────
  header('1. 기본 정보');
  // Cloudflare workers.dev 서브도메인 제약: 소문자/숫자/하이픈, 1~63자,
  // 하이픈으로 시작·종료 불가. https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
  const workerName = await ask('Cloudflare Workers 앱 이름', {
    def: 'cloudwiki',
    validate: v => {
      if (v.length < 1 || v.length > 63) return '1~63자 사이여야 합니다.';
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v)) {
        return '소문자/숫자/하이픈만 사용 가능하며, 하이픈으로 시작·종료할 수 없습니다.';
      }
      return true;
    },
  });

  info('도메인이 없다면 워커 임시 주소(예: my-wiki.username.workers.dev)를 입력하세요.');
  const domain = await ask('사이트 도메인 (https:// 제외, 예: wiki.example.com)', {
    validate: v => v.length > 0 || '도메인을 입력해주세요.',
  });
  const baseUrl = `https://${domain}`;
  ok(`기본 URL: ${baseUrl}`);

  const wikiName = await ask('사이트 전역에 표시할 위키 이름', { def: 'CloudWiki' });
  const wikiHomePage = await ask('위키 홈페이지로 사용할 문서 제목', { def: '대문' });

  const superAdminEmails = await ask('슈퍼 관리자 이메일 (콤마로 구분)', {
    validate: v => v.includes('@') || '최소 1개의 이메일을 입력해주세요.',
  });

  // ── 2. Cloudflare 리소스 ─────────────────────────────────
  header('2. Cloudflare 리소스 (D1 / R2 / KV)');
  const autoCreate = await askYesNo(
    'wrangler CLI 로 D1/R2/KV 리소스를 지금 자동 생성할까요? (이미 로그인되어 있어야 합니다)',
    { def: 'n' }
  );

  let d1Name = '', d1Id = '', r2Name = '', kvId = '';

  if (autoCreate) {
    info('Wrangler 로그인 상태를 확인합니다...');
    if (isWranglerLoggedIn()) {
      ok('Wrangler 로그인이 확인되었습니다.');
    } else {
      warn('Wrangler 에 로그인되어 있지 않습니다.');
      if (isContainerEnv()) {
        warn('컨테이너/원격 환경이 감지되었습니다. `wrangler login` 은 localhost OAuth 콜백을 사용하므로');
        warn('이 환경에서는 브라우저 리다이렉트가 차단되어 무한 대기 상태가 될 수 있습니다.');
        info('대안: CLOUDFLARE_API_TOKEN 환경변수를 설정하면 wrangler 가 자동으로 인증합니다.');
        info('  export CLOUDFLARE_API_TOKEN=<your-api-token>  # 발급: https://dash.cloudflare.com/profile/api-tokens');
        info('환경변수를 설정한 후 스크립트를 다시 실행해주세요.');
        rl.close();
        process.exit(1);
      }
      const doLogin = await askYesNo('지금 wrangler login 을 실행할까요?', { def: 'y' });
      if (doLogin) {
        info('브라우저가 열립니다. Cloudflare 계정으로 로그인해주세요...');
        const loginOk = runWranglerLogin();
        if (loginOk) {
          ok('로그인 완료.');
        } else {
          err('로그인에 실패했습니다. 수동으로 `npx wrangler login` 을 실행한 후 다시 시도해주세요.');
          rl.close();
          process.exit(1);
        }
      } else {
        err('로그인 없이는 리소스를 자동 생성할 수 없습니다. 수동으로 리소스를 생성한 뒤 다시 실행해주세요.');
        rl.close();
        process.exit(1);
      }
    }
    d1Name = await ask('D1 데이터베이스 이름', { def: `${workerName}-db` });
    info(`D1 데이터베이스 "${d1Name}" 을 생성합니다...`);
    const d1Res = runWrangler(['d1', 'create', d1Name]);
    if (d1Res.ok) {
      const id = extractD1Id(d1Res.stdout);
      if (id) {
        d1Id = id;
        ok(`D1 생성 완료. database_id = ${id}`);
      } else {
        warn('D1 출력에서 ID를 자동 추출하지 못했습니다.');
        console.log(d1Res.stdout);
        d1Id = await ask('database_id 를 직접 입력해주세요');
      }
    } else {
      err('D1 생성 실패: ' + (d1Res.stderr || d1Res.stdout));
      d1Id = await ask('이미 존재한다면 기존 database_id 를 입력해주세요');
    }

    r2Name = await ask('R2 버킷 이름', { def: `${workerName}-media` });
    info(`R2 버킷 "${r2Name}" 을 생성합니다...`);
    const r2Res = runWrangler(['r2', 'bucket', 'create', r2Name]);
    if (r2Res.ok) {
      ok('R2 버킷 생성 완료.');
    } else {
      err('R2 버킷 생성 실패: ' + (r2Res.stderr || r2Res.stdout).split('\n')[0]);
      r2Name = await ask('실제로 사용할 R2 버킷 이름을 입력해주세요 (대시보드에서 생성 후 정확한 이름)', {
        validate: v => v.length > 0 || '필수 값입니다.',
      });
    }

    const kvTitle = await ask('KV 네임스페이스 이름', { def: `${workerName}-kv` });
    info(`KV 네임스페이스 "${kvTitle}" 을 생성합니다...`);
    const kvRes = runWrangler(['kv', 'namespace', 'create', kvTitle]);
    if (kvRes.ok) {
      const id = extractKvId(kvRes.stdout);
      if (id) {
        kvId = id;
        ok(`KV 생성 완료. id = ${id}`);
      } else {
        warn('KV 출력에서 ID를 자동 추출하지 못했습니다.');
        console.log(kvRes.stdout);
        kvId = await ask('KV id 를 직접 입력해주세요');
      }
    } else {
      err('KV 생성 실패: ' + (kvRes.stderr || kvRes.stdout));
      kvId = await ask('이미 존재한다면 기존 KV id 를 입력해주세요');
    }
  } else {
    info('Cloudflare 대시보드에서 미리 생성해둔 리소스의 ID를 입력해주세요.');
    d1Name = await ask('D1 데이터베이스 이름 (database_name)');
    d1Id = await ask('D1 database_id', {
      validate: v => /^[0-9a-f-]{36}$/i.test(v) || 'UUID 형식 (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)이 아닙니다.',
    });
    r2Name = await ask('R2 버킷 이름 (bucket_name)');
    kvId = await ask('KV 네임스페이스 id', {
      validate: v => /^[0-9a-f]{32}$/i.test(v) || 'KV id 는 32자리 16진수입니다.',
    });
  }

  const analyticsDataset = await ask('Analytics Engine dataset 이름', { def: `${workerName}_analytics` });

  // ── 3. OAuth ─────────────────────────────────────────────
  header('3. OAuth 공급자 설정');
  const provider = await askChoice('어떤 로그인 공급자를 사용하시겠습니까?', [
    { label: 'Google 만 사용',       value: 'google',         hint: '구글 계정 로그인' },
    { label: 'Discord 만 사용',      value: 'discord',        hint: '디스코드 계정 로그인' },
    { label: 'Google + Discord 모두', value: 'google,discord', hint: '권장' },
  ], { def: 2 });

  let googleClientId = '';
  let discordClientId = '';

  if (provider.includes('google')) {
    info('Google Cloud Console > OAuth 2.0 클라이언트 ID 에서 발급받은 값입니다.');
    info(`승인된 리디렉션 URI 에 ${baseUrl}/auth/google/callback 가 등록되어 있어야 합니다.`);
    googleClientId = await ask('GOOGLE_CLIENT_ID', {
      validate: v => v.length > 0 || '필수 값입니다.',
    });
    info('GOOGLE_CLIENT_SECRET 은 배포 후 Workers 대시보드에서 비밀(Secret) 변수로 등록합니다.');
  }
  if (provider.includes('discord')) {
    info('Discord Developer Portal > OAuth2 에서 발급받은 값입니다.');
    info(`리디렉션 URI 에 ${baseUrl}/auth/discord/callback 가 등록되어 있어야 합니다.`);
    discordClientId = await ask('DISCORD_CLIENT_ID', {
      validate: v => v.length > 0 || '필수 값입니다.',
    });
    info('DISCORD_CLIENT_SECRET 은 배포 후 Workers 대시보드에서 비밀(Secret) 변수로 등록합니다.');
  }

  // ── 4. Turnstile ─────────────────────────────────────────
  header('4. Cloudflare Turnstile (편집 보호)');
  info('Cloudflare 대시보드 > Turnstile 에서 위젯을 추가하면 사이트 키를 발급받습니다.');
  const turnstileSiteKey = await ask('TURNSTILE_SITE_KEY (없으면 빈 값)', { def: '' });

  // ── 5. 위키 정책 ─────────────────────────────────────────
  header('5. 위키 정책');
  const visibility = await askChoice('문서 열람 권한', [
    { label: 'open',   value: 'open',   hint: '비로그인 사용자도 열람 가능' },
    { label: 'closed', value: 'closed', hint: '로그인한 사용자만 열람 가능' },
  ], { def: 0 });

  const mcpMode = await askChoice('MCP 서버 모드 (AI 에이전트용)', [
    { label: 'disabled', value: 'disabled', hint: '사용 안 함' },
    { label: 'open',     value: 'open',     hint: '전체 개방' },
  ], { def: 1 });

  const allowCrawl = await askYesNo('검색엔진 크롤링 허용 (sitemap.xml 자동 생성)', { def: 'y' });
  const concurrentEdit = await askYesNo('동시편집 감지 활성화 (KV 사용)', { def: 'y' });

  const emailRestriction = await askChoice('이메일 도메인 가입 제한', [
    { label: '제한 없음',          value: '' },
    { label: '화이트리스트 (허용 도메인만 가입)', value: 'whitelist' },
    { label: '블랙리스트 (차단 도메인 제외)',    value: 'blacklist' },
  ], { def: 0 });
  let emailList = 'example.com';
  if (emailRestriction) {
    emailList = await ask('대상 이메일 도메인 목록 (콤마 구분)', {
      validate: v => v.length > 0 || '도메인을 1개 이상 입력해주세요.',
    });
  }

  // ── 6. 업로드 ────────────────────────────────────────────
  header('6. 미디어 업로드');
  const maxUploadMB = await ask('최대 업로드 크기 (MB)', {
    def: '15',
    validate: v => /^\d+$/.test(v) && +v > 0 || '양의 정수를 입력해주세요.',
  });
  const maxUploadBytes = String(parseInt(maxUploadMB, 10) * 1024 * 1024);

  // ── 7. 문서 페이지 이름 ─────────────────────────────────
  header('7. 도움말/약관 문서 제목');
  info('비워두면 기본값으로 설정됩니다. 위키 가동 후 해당 제목의 문서를 직접 작성하세요.');
  const privacyPolicy   = await ask('개인정보처리방침 문서 제목', { def: '위키/개인정보처리방침' });
  const termsOfService  = await ask('이용약관 문서 제목',         { def: '위키/이용약관' });
  const wikiSyntax      = await ask('위키 문법 가이드 문서 제목',  { def: '위키/위키 문법 가이드' });

  // ── 8. VAPID ─────────────────────────────────────────────
  header('8. Web Push (VAPID) 키');
  const wantVapid = await askYesNo('VAPID 키를 자동 생성할까요? (Web Push 미사용 시 N)', { def: 'y' });
  let vapidPublicKey = '';
  let vapidSubject = '';
  let vapidPrivateKey = '';
  if (wantVapid) {
    const kp = await generateVapid();
    vapidPublicKey = kp.publicKey;
    vapidPrivateKey = kp.privateKey;
    vapidSubject = await ask('VAPID subject (운영자 연락처)', {
      def: `mailto:${superAdminEmails.split(',')[0].trim()}`,
    });
    ok('VAPID 키 생성 완료. 비밀키는 마지막 단계에서 안내됩니다.');
  }

  // ─────────────────────────────────────────────────────────
  // 템플릿 치환
  // ─────────────────────────────────────────────────────────
  let out = template;

  // worker name (파일 첫 줄)
  out = out.replace(/^name\s*=\s*"[^"]*"/m, `name = "${escapeTomlBasic(workerName)}"`);

  // D1 / R2 / KV / Analytics
  out = setKeyInSection(out, '[[d1_databases]]', 'database_name', d1Name);
  out = setKeyInSection(out, '[[d1_databases]]', 'database_id',   d1Id);
  out = setKeyInSection(out, '[[r2_buckets]]',   'bucket_name',   r2Name);
  out = setKeyInSection(out, '[[kv_namespaces]]', 'id',           kvId);
  out = setKeyInSection(out, '[[analytics_engine_datasets]]', 'dataset', analyticsDataset);

  // [vars] 영역의 평면 키들
  const vars = {
    WIKI_HOME_PAGE:                wikiHomePage,
    AUTH_PROVIDERS:                provider,
    GOOGLE_CLIENT_ID:              googleClientId,
    GOOGLE_REDIRECT_URI:           provider.includes('google')  ? `${baseUrl}/auth/google/callback`  : '',
    DISCORD_CLIENT_ID:             discordClientId,
    DISCORD_REDIRECT_URI:          provider.includes('discord') ? `${baseUrl}/auth/discord/callback` : '',
    TURNSTILE_SITE_KEY:            turnstileSiteKey,
    MEDIA_PUBLIC_URL:              `${baseUrl}/media`,
    MAX_UPLOAD_SIZE:               maxUploadBytes,
    WIKI_NAME:                     wikiName,
    SUPER_ADMIN_EMAILS:            superAdminEmails,
    MCP_MODE:                      mcpMode,
    ALLOW_CRAWL:                   allowCrawl ? 'true' : 'false',
    ENABLE_CONCURRENT_EDIT_DETECTION: concurrentEdit ? 'true' : 'false',
    WIKI_VISIBILITY:               visibility,
    EMAIL_RESTRICTION:             emailRestriction,
    EMAIL_LIST:                    emailList,
    PRIVACY_POLICY:                privacyPolicy,
    TERMS_OF_SERVICE:              termsOfService,
    WIKI_SYNTAX:                   wikiSyntax,
    WIKI_PUBLIC_BASE_URL:          baseUrl,
    VAPID_PUBLIC_KEY:              vapidPublicKey,
    VAPID_SUBJECT:                 vapidSubject,
  };

  for (const [k, v] of Object.entries(vars)) {
    out = setSingleKey(out, k, v);
  }

  // 결과 기록
  await writeFile(OUTPUT_PATH, out, 'utf8');
  ok(`wrangler.toml 작성 완료 → ${OUTPUT_PATH}`);

  // ── 9. 다음 단계 ────────────────────────────────────────
  header('다음 단계 (배포 후 진행)');
  const todo = [];
  todo.push('1) GitHub 프라이빗 레포에 코드를 push 한 뒤 Cloudflare 대시보드 > Workers & Pages 에서 응용 프로그램 생성 → Continue with GitHub 로 연동/배포');
  todo.push('2) D1 콘솔(Explore Data > Query) 에서 migrations/schema.sql 의 모든 statement 실행');
  todo.push('3) Workers 설정 > 변수 및 암호에서 다음 항목을 비밀(Secret) 변수로 등록:');
  if (provider.includes('google'))  todo.push('   • GOOGLE_CLIENT_SECRET');
  if (provider.includes('discord')) todo.push('   • DISCORD_CLIENT_SECRET');
  if (turnstileSiteKey)             todo.push('   • TURNSTILE_SECRET_KEY');
  todo.push('   • (선택) CF_ACCOUNT_ID, CF_API_TOKEN — Analytics Engine 통계 조회용');
  todo.push('   • (선택) DISCORD_ADMIN_WEBHOOK_URL, DISCORD_COMMUNITY_WEBHOOK_URL — Discord 알림');
  if (vapidPrivateKey) {
    todo.push('   • VAPID_PRIVATE_KEY = ' + vapidPrivateKey);
    todo.push('     (위 값을 안전한 곳에 즉시 보관하세요. 스크립트는 디스크에 저장하지 않습니다.)');
  }
  todo.push('4) Workers 설정 > 도메인 및 경로에서 사용자 설정 도메인 추가');
  todo.push('5) OAuth 공급자 콘솔에 리디렉션 URI 가 등록되어 있는지 재확인:');
  if (provider.includes('google'))  todo.push(`   • Google:  ${baseUrl}/auth/google/callback`);
  if (provider.includes('discord')) todo.push(`   • Discord: ${baseUrl}/auth/discord/callback`);

  console.log('');
  todo.forEach(l => console.log('  ' + l));
  console.log('');
  ok('설치 마법사 종료. 즐거운 위키 운영 되세요!');

  rl.close();
}

main().catch(e => {
  // 사용자가 readline 프롬프트에서 Ctrl+C 를 누르면 readline 이 닫히면서
  // 보류 중이던 question() Promise 가 거부된다. 이를 정상 취소로 처리해
  // 스택 트레이스를 출력하지 않는다.
  if (cancelled || e?.code === 'ERR_USE_AFTER_CLOSE' || e?.name === 'AbortError') {
    handleCancel();
    return;
  }
  err(e?.stack || String(e));
  rl.close();
  process.exit(1);
});
