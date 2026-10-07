// ─── Shared helpers for auth pages ───────────────────────────────────
import { icon, logo } from './icons.js';
import { modal } from './ui.js';

export function mountAside() {
  const brand = document.getElementById('aside-brand');
  if (brand) brand.innerHTML = logo({ light: true, size: 36 });
  const pts = { pt1: 'coins', pt2: 'list', pt3: 'shield' };
  for (const [id, ic] of Object.entries(pts)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = icon(ic);
  }
}

export function mountVisibilityToggle(inputId, btnId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.innerHTML = icon('eye');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = icon(show ? 'eyeOff' : 'eye');
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

export function showFormError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

export function legalModal(kind) {
  const terms = kind === 'terms';
  modal({
    title: terms ? 'Terms of Service' : 'Privacy Policy',
    width: 560,
    body: `<div class="legal-text">${terms ? TERMS_HTML : PRIVACY_HTML}</div>`,
    actions: '<button class="btn primary" data-close>Got it</button>'
  }).root.querySelector('[data-close]').addEventListener('click', (e) => {
    e.target.closest('.modal-overlay').querySelector('.modal-x, .floating')?.click();
  });
}

const TERMS_HTML = `
  <p><em>Last updated: 7 October 2026. By creating an account or using AfnoKamai, you agree to these Terms of Service.</em></p>
  <h4>1. The service</h4>
  <p>AfnoKamai is a task-and-reward platform where users complete administrator-approved digital tasks in exchange for NPR rewards. Availability of tasks is not guaranteed.</p>
  <h4>2. Your account</h4>
  <ul>
    <li>One account per person. Multiple accounts to farm rewards are prohibited.</li>
    <li>You must provide accurate personal information and keep it current.</li>
    <li>You are responsible for keeping your password and security PIN confidential.</li>
    <li>Some tasks require creating accounts on third-party services. Those accounts are created strictly to complete the task. Keeping or using any account created for a task for personal purposes is a serious violation that results in a permanent <strong>ID ban</strong>.</li>
  </ul>
  <h4>3. Tasks and rewards</h4>
  <ul>
    <li>Tasks must be completed exactly as instructed. False completion claims, manipulated evidence, duplicate submissions, or any manipulation of the platform may result in rejection, penalties, suspension or permanent banning.</li>
    <li>Approved rewards enter a hold period before becoming withdrawable. Hold lengths are shown for each reward.</li>
    <li>Never use tasks to violate the terms, policies or security of any third-party service.</li>
  </ul>
  <h4>4. Withdrawals</h4>
  <ul>
    <li>You may request a withdrawal only when your withdrawable balance is at least <strong>रु500 (NPR 500)</strong> <strong>and</strong> your account has at least <strong>50 approved tasks</strong>. Both conditions must be met.</li>
    <li>Withdrawals are paid only to your own verified eSewa account, and only one request can be in progress at a time.</li>
    <li>Withdrawals are reviewed by administrators before completion. Fraudulent requests are rejected.</li>
  </ul>
  <h4>5. Administrator authority</h4>
  <ul>
    <li>All administrator decisions — task approvals and rejections, reward amounts, holds, penalties and withdrawal outcomes — are <strong>final</strong>.</li>
    <li>Any misbehavior toward an administrator, or any attempt to scam, deceive or defraud an administrator (including through chat or support), results in an immediate and permanent <strong>ID ban</strong>.</li>
  </ul>
  <h4>6. No income guarantee</h4>
  <p>AfnoKamai does not promise any level of income. Rewards depend entirely on the availability and successful completion of tasks.</p>
  <h4>7. Changes</h4>
  <p>We may update these terms; continued use of the platform constitutes acceptance of the updated terms. The current version is always available on the signup page and in Task Rules.</p>`;

const PRIVACY_HTML = `
  <p><em>Last updated: 7 October 2026. This policy explains what AfnoKamai collects, how it is used, and the choices you have.</em></p>
  <h4>What we collect</h4>
  <ul>
    <li>Account details: your name, email address and phone number.</li>
    <li>Financial records: task rewards, holds, withdrawals and penalties — kept for audit purposes.</li>
    <li>Communications: messages and media you send through platform chat.</li>
    <li>Task evidence: the screenshots and photos you submit to prove task completion.</li>
  </ul>
  <h4>How we use it</h4>
  <ul>
    <li>To operate the platform: assigning tasks, verifying completions, processing eSewa withdrawals.</li>
    <li>To secure accounts: verification emails, security PIN checks, fraud prevention.</li>
    <li>To communicate: transactional notifications about your account and rewards.</li>
    <li>To enforce the rules: reviewing submitted evidence and applying holds, penalties or bans where the terms require them.</li>
  </ul>
  <h4>What we never do</h4>
  <ul>
    <li>We never ask for your eSewa password or your AfnoKamai security PIN outside the app.</li>
    <li>We never sell your personal information.</li>
  </ul>
  <h4>Data security</h4>
  <p>Your data is stored on secure cloud infrastructure — Firebase for authentication and Appwrite for databases — with strict access rules. Financial changes are made exclusively through audited server-side transactions.</p>
  <h4>Data retention</h4>
  <p>Account and financial records are kept while your account is active, and for as long as audit and record-keeping obligations require. If your account is banned, the violation record and financial history are retained.</p>
  <h4>Your rights</h4>
  <p>You may request correction or deletion of your personal information by contacting support, subject to record-keeping requirements for financial transactions.</p>
  <h4>Changes</h4>
  <p>We may update this policy; continued use of the platform constitutes acceptance of the updated policy.</p>`;
