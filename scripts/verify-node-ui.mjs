import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:18081'
const output = path.resolve(process.argv[3] ?? '.redtrace/tmp/node-ui.png')
const title = `Browser FGS acceptance ${Date.now()}`
await mkdir(path.dirname(output), { recursive: true })
const installedChrome = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined
const executablePath = process.env.REDTRACE_BROWSER_PATH || (installedChrome && existsSync(installedChrome) ? installedChrome : undefined)
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }), page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
try {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'new', exact: true }).click()
  const modal = page.locator('[x-show="showNewProject"]')
  await modal.locator('input').first().fill(title)
  await modal.locator('textarea').nth(0).fill('Local browser fixture')
  await modal.locator('textarea').nth(1).fill('Operate Goal, Step and Finding')
  await modal.locator('input[type="checkbox"]').uncheck()
  await modal.locator('button').last().click()
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
  const projects = await (await fetch(`${base}/projects`)).json(), projectId = projects.find(project => project.title === title).id
  await page.getByRole('button', { name: 'FGS', exact: true }).click()
  const fgsPanel = page.locator('[x-show="sideTab === \'fgs\'"]')
  await fgsPanel.getByText('Operate Goal, Step and Finding', { exact: true }).waitFor()

  const answers = []
  page.on('dialog', async dialog => dialog.accept(answers.shift() ?? ''))
  answers.push('Browser sub goal', 'goal')
  await page.getByRole('button', { name: 'Add sub goal' }).click()
  await fgsPanel.getByText('Browser sub goal', { exact: true }).waitFor()
  answers.push('Browser manual step', 'origin', 'goal')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  await page.getByRole('button', { name: 'Add step' }).click()
  await page.locator('[x-show="sideTab === \'steps\'"]').getByText('Browser manual step', { exact: true }).waitFor()
  const factResponse = await fetch(`${base}/v2/projects/${projectId}/facts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Verified browser evidence', evidence: [{ description: 'Local fixture observation' }] }) })
  if (!factResponse.ok) throw new Error(`Fact creation failed: ${factResponse.status}`)
  const fact = await factResponse.json()
  await page.getByRole('button', { name: 'FGS', exact: true }).click()
  answers.push('Browser finding', 'Visible evidence finding', fact.id)
  await page.getByRole('button', { name: 'Add finding' }).click()
  await fgsPanel.getByText('Browser finding', { exact: true }).waitFor()
  await fgsPanel.getByText('Browser sub goal', { exact: true }).click()
  answers.push(fact.id)
  await page.getByRole('button', { name: 'Achieve' }).click()
  await fgsPanel.getByText('Browser sub goal', { exact: true }).click()
  const selected = page.getByTestId('fgs-node-detail'), box = await selected.boundingBox()
  if (!box || box.width < 100 || box.height < 40) throw new Error(`FGS selection has invalid geometry: ${JSON.stringify(box)}`)
  await page.screenshot({ path: output, fullPage: true })

  await page.locator('header:visible button').first().click()
  for (const name of ['Skills', 'MCP', 'WebShell管理', '打开 C2', '插件', '日志', '设置', '工作台']) {
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(60)
    if (!(await page.locator('main:visible, [x-show]:visible').count())) throw new Error(`${name} page did not render`)
  }
  const graph = await (await fetch(`${base}/v2/projects/${projectId}/graph`)).json()
  if (!graph.goals.some(goal => goal.description === 'Browser sub goal' && goal.status === 'achieved')) throw new Error('Sub Goal update was not persisted')
  if (!graph.steps.some(step => step.description === 'Browser manual step')) throw new Error('Step create was not persisted')
  if (!graph.findings.some(finding => finding.title === 'Browser finding')) throw new Error('Finding create was not persisted')
  if (graph.nodes.some(node => !['scope', 'fact', 'finding', 'subgoal', 'goal'].includes(node.nodeType))) throw new Error('Execution nodes leaked into FGS')
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, screenshot: output, geometry: box, goals: graph.goals.length, steps: graph.steps.length, findings: graph.findings.length }))
} finally { await browser.close() }
