import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createComponent, createElement, insert } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { homedir } from "node:os"
import path from "node:path"
import { existsSync, readFileSync } from "node:fs"

const GITHUB_API_BASE_URL = "https://api.github.com"
const AUTH_PATH = path.join(homedir(), ".local", "share", "opencode", "auth.json")
const COPILOT_QUOTA_CONFIG_PATH = path.join(homedir(), ".config", "opencode", "copilot-quota-token.json")
const COPILOT_VERSION = "0.35.0"
const EDITOR_VERSION = "vscode/1.107.0"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const POLL_MS = 60_000
const COPILOT_HEADERS = {
  "User-Agent": USER_AGENT,
  "Editor-Version": EDITOR_VERSION,
  "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  "Copilot-Integration-Id": "vscode-chat",
}

type CopilotQuotaConfig = {
  token: string
  username: string
  tier: keyof typeof COPILOT_PLAN_LIMITS
}

type CopilotAuth = {
  type?: string
  access?: string
  refresh?: string
  expires?: number
}

type InternalQuota = {
  entitlement: number
  remaining: number
  percent_remaining: number
  unlimited?: boolean
}

type InternalUsage = {
  copilot_plan: string
  quota_reset_date: string
  quota_snapshots: {
    premium_interactions?: InternalQuota
  }
}

type PublicUsageItem = {
  sku: string
  grossQuantity: number
}

type PublicUsage = {
  user: string
  usageItems: PublicUsageItem[]
}

type QuotaSnapshot = {
  text: string
  stale: boolean
}

const COPILOT_PLAN_LIMITS = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
} as const

let snapshot: QuotaSnapshot = { text: "Copilot ...", stale: false }
let timer: ReturnType<typeof setInterval> | undefined
let inFlight: Promise<void> | undefined
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setSnapshot(next: QuotaSnapshot) {
  snapshot = next
  emit()
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

function readQuotaConfig(): CopilotQuotaConfig | null {
  const config = readJsonFile<CopilotQuotaConfig>(COPILOT_QUOTA_CONFIG_PATH)
  if (!config?.token || !config.username || !config.tier) return null
  if (!(config.tier in COPILOT_PLAN_LIMITS)) return null
  return config
}

function readCopilotAuth(): CopilotAuth | null {
  const auth = readJsonFile<Record<string, CopilotAuth>>(AUTH_PATH)
  return auth?.["github-copilot"] ?? null
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function exchangeForCopilotToken(oauthToken: string) {
  try {
    const response = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthToken}`,
        ...COPILOT_HEADERS,
      },
    })

    if (!response.ok) return null
    const tokenData = await response.json()
    return tokenData.token as string | null
  } catch {
    return null
  }
}

function buildBearerHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...COPILOT_HEADERS,
  }
}

function buildLegacyHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `token ${token}`,
    ...COPILOT_HEADERS,
  }
}

async function fetchPublicBillingUsage(config: CopilotQuotaConfig) {
  const response = await fetchWithTimeout(
    `${GITHUB_API_BASE_URL}/users/${config.username}/settings/billing/premium_request/usage`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )

  if (!response.ok) throw new Error(`GitHub billing API returned ${response.status}`)
  return (await response.json()) as PublicUsage
}

async function fetchInternalUsage(authData: CopilotAuth) {
  const oauthToken = authData.refresh || authData.access
  if (!oauthToken) throw new Error("Missing GitHub Copilot OAuth token")

  const cachedAccessToken = authData.access
  const tokenExpiry = authData.expires || 0

  if (cachedAccessToken && cachedAccessToken !== oauthToken && tokenExpiry > Date.now()) {
    const response = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
      headers: buildBearerHeaders(cachedAccessToken),
    })
    if (response.ok) return (await response.json()) as InternalUsage
  }

  const directResponse = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: buildLegacyHeaders(oauthToken),
  })
  if (directResponse.ok) return (await directResponse.json()) as InternalUsage

  const exchangedToken = await exchangeForCopilotToken(oauthToken)
  if (!exchangedToken) throw new Error("Could not exchange GitHub token for Copilot quota access")

  const exchangedResponse = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: buildBearerHeaders(exchangedToken),
  })

  if (!exchangedResponse.ok) throw new Error(`GitHub Copilot API returned ${exchangedResponse.status}`)
  return (await exchangedResponse.json()) as InternalUsage
}

function getResetCountdown(resetDate: string) {
  const reset = new Date(resetDate)
  const diffMs = reset.getTime() - Date.now()
  if (diffMs <= 0) return "soon"

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h`
}

function formatPublicStatus(data: PublicUsage, tier: CopilotQuotaConfig["tier"]) {
  const limit = COPILOT_PLAN_LIMITS[tier]
  const used = data.usageItems
    .filter((item) => item.sku === "Copilot Premium Request" || item.sku.includes("Premium"))
    .reduce((sum, item) => sum + item.grossQuantity, 0)
  const usedPercent = ((used / limit) * 100).toFixed(1)
  return `Copilot ${usedPercent}% used`
}

function formatInternalStatus(data: InternalUsage) {
  const premium = data.quota_snapshots.premium_interactions
  if (!premium) return `Copilot ${data.copilot_plan}`
  if (premium.unlimited) return `Copilot ${data.copilot_plan} unlimited`
  const used = premium.entitlement - premium.remaining
  const usedPercent = ((used / premium.entitlement) * 100).toFixed(1)
  return `Copilot ${usedPercent}% used`
}

async function loadQuotaText() {
  const quotaConfig = readQuotaConfig()
  if (quotaConfig) {
    const usage = await fetchPublicBillingUsage(quotaConfig)
    return formatPublicStatus(usage, quotaConfig.tier)
  }

  const auth = readCopilotAuth()
  if (!auth || auth.type !== "oauth") throw new Error("GitHub Copilot auth is not configured")

  const usage = await fetchInternalUsage(auth)
  const base = formatInternalStatus(usage)
  return `${base} | ${getResetCountdown(usage.quota_reset_date)}`
}

async function refreshQuota() {
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const text = await loadQuotaText()
      setSnapshot({ text, stale: false })
    } catch {
      if (!snapshot.stale && snapshot.text !== "Copilot ...") {
        setSnapshot({ ...snapshot, stale: true })
        return
      }
      setSnapshot({ text: "Copilot unavailable", stale: true })
    } finally {
      inFlight = undefined
    }
  })()

  return inFlight
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  if (listeners.size === 1) {
    void refreshQuota()
    timer = setInterval(() => {
      void refreshQuota()
    }, POLL_MS)
  } else {
    listener()
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

function CopilotQuotaStatus() {
  const [text, setText] = createSignal(snapshot.text)

  onMount(() => {
    const sync = () => setText(snapshot.stale ? `${snapshot.text} (stale)` : snapshot.text)
    sync()
    const unsubscribe = subscribe(sync)
    onCleanup(unsubscribe)
  })

  const node = createElement("text")
  insert(node, text)
  return node
}

const plugin: TuiPluginModule = {
  id: "copilot-quota-status",
  async tui(api) {
    api.slots.register({
      order: 1000,
      slots: {
        home_prompt_right: () => createComponent(CopilotQuotaStatus, {}),
        session_prompt_right: () => createComponent(CopilotQuotaStatus, {}),
      },
    })

    const offConnected = api.event.on("server.connected", () => {
      void refreshQuota()
    })

    api.lifecycle.onDispose(offConnected)
  },
}

export default plugin
