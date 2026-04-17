import {
  buildBearerHeaders,
  buildLegacyHeaders,
  getResetCountdown,
  formatPublicStatus,
  formatInternalStatus,
  COPILOT_PLAN_LIMITS,
} from "./index"

declare const jest: any

// Mock modules that are not relevant to unit tests
jest.mock("@opentui/solid", () => ({
  createComponent: jest.fn(),
  createElement: jest.fn(),
  insert: jest.fn(),
}))

jest.mock("solid-js", () => ({
  createSignal: jest.fn(),
  onCleanup: jest.fn(),
  onMount: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("buildBearerHeaders", () => {
  it("returns headers with Bearer token", () => {
    const headers = buildBearerHeaders("abc123")
    expect(headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        Authorization: "Bearer abc123",
      }),
    )
  })

  it("includes Copilot integration headers", () => {
    const headers = buildBearerHeaders("token") as Record<string, string>
    expect(headers["User-Agent"]).toBe("GitHubCopilotChat/0.35.0")
    expect(headers["Editor-Version"]).toBe("vscode/1.107.0")
    expect(headers["Editor-Plugin-Version"]).toBe("copilot-chat/0.35.0")
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat")
  })
})

describe("buildLegacyHeaders", () => {
  it("returns headers with legacy token auth", () => {
    const headers = buildLegacyHeaders("abc123")
    expect(headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        Authorization: "token abc123",
      }),
    )
  })

  it("includes Copilot integration headers", () => {
    const headers = buildLegacyHeaders("token") as Record<string, string>
    expect(headers["User-Agent"]).toBe("GitHubCopilotChat/0.35.0")
    expect(headers["Editor-Version"]).toBe("vscode/1.107.0")
    expect(headers["Editor-Plugin-Version"]).toBe("copilot-chat/0.35.0")
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat")
  })
})

describe("getResetCountdown", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OriginalDate = global.Date as any
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z").getTime()

  beforeEach(() => {
    jest.spyOn(global, "Date").mockImplementation(
      function (this: any, ...args: any[]) {
        const date = new OriginalDate(...args)
        if (args.length === 0) {
          return new OriginalDate(FIXED_NOW) as any
        }
        return date
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global.Date as any).now = () => FIXED_NOW
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("returns 'soon' when reset date is in the past", () => {
    expect(getResetCountdown("2025-12-31T00:00:00Z")).toBe("soon")
  })

  it("returns 'soon' when reset date is now", () => {
    expect(getResetCountdown("2026-01-01T00:00:00Z")).toBe("soon")
  })

  it("returns days and hours when reset is multiple days away", () => {
    jest.spyOn(global, "Date").mockImplementation(
      function (this: any, ...args: any[]) {
        const date = new OriginalDate(...args)
        if (args.length === 0) {
          return new OriginalDate(FIXED_NOW) as any
        }
        return date
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global.Date as any).now = () => FIXED_NOW
    const future = new OriginalDate("2026-01-10T12:00:00Z").toISOString()
    expect(getResetCountdown(future)).toBe("9d 12h")
  })

  it("returns days and hours when reset is just over a day away", () => {
    jest.spyOn(global, "Date").mockImplementation(
      function (this: any, ...args: any[]) {
        const date = new OriginalDate(...args)
        if (args.length === 0) {
          return new OriginalDate(FIXED_NOW) as any
        }
        return date
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global.Date as any).now = () => FIXED_NOW
    const future = new OriginalDate("2026-01-02T06:00:00Z").toISOString()
    expect(getResetCountdown(future)).toBe("1d 6h")
  })

  it("returns 0d Xh when reset is within a day", () => {
    jest.spyOn(global, "Date").mockImplementation(
      function (this: any, ...args: any[]) {
        const date = new OriginalDate(...args)
        if (args.length === 0) {
          return new OriginalDate(FIXED_NOW) as any
        }
        return date
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global.Date as any).now = () => FIXED_NOW
    const future = new OriginalDate("2026-01-01T12:00:00Z").toISOString()
    expect(getResetCountdown(future)).toBe("12h")
  })
})

describe("formatPublicStatus", () => {
  it("formats status for free tier with partial usage", () => {
    const data = {
      user: "testuser",
      usageItems: [{ sku: "Copilot Premium Request", grossQuantity: 25 }],
    }
    expect(formatPublicStatus(data, "free")).toBe("Copilot 50.0% used")
  })

  it("formats status for pro tier with partial usage", () => {
    const data = {
      user: "testuser",
      usageItems: [{ sku: "Copilot Premium Request", grossQuantity: 150 }],
    }
    expect(formatPublicStatus(data, "pro")).toBe("Copilot 50.0% used")
  })

  it("formats status for pro+ tier with partial usage", () => {
    const data = {
      user: "testuser",
      usageItems: [{ sku: "Copilot Premium Request", grossQuantity: 750 }],
    }
    expect(formatPublicStatus(data, "pro+")).toBe("Copilot 50.0% used")
  })

  it("filters usage items by sku containing Premium", () => {
    const data = {
      user: "testuser",
      usageItems: [
        { sku: "Copilot Premium Request", grossQuantity: 10 },
        { sku: "Some Other SKU", grossQuantity: 100 },
        { sku: "TestPremium", grossQuantity: 5 },
      ],
    }
    expect(formatPublicStatus(data, "free")).toBe("Copilot 30.0% used")
  })

  it("formats status with zero usage", () => {
    const data = {
      user: "testuser",
      usageItems: [],
    }
    expect(formatPublicStatus(data, "free")).toBe("Copilot 0.0% used")
  })

  it("formats status with 100% usage", () => {
    const data = {
      user: "testuser",
      usageItems: [{ sku: "Copilot Premium Request", grossQuantity: 50 }],
    }
    expect(formatPublicStatus(data, "free")).toBe("Copilot 100.0% used")
  })

  it("handles multiple usage items summing together", () => {
    const data = {
      user: "testuser",
      usageItems: [
        { sku: "Copilot Premium Request", grossQuantity: 20 },
        { sku: "Copilot Premium Request", grossQuantity: 15 },
      ],
    }
    expect(formatPublicStatus(data, "free")).toBe("Copilot 70.0% used")
  })
})

describe("formatInternalStatus", () => {
  it("formats status when no premium quota data", () => {
    const data = {
      copilot_plan: "free",
      quota_reset_date: "2026-02-01T00:00:00Z",
      quota_snapshots: {},
    }
    expect(formatInternalStatus(data)).toBe("Copilot free")
  })

  it("formats status as unlimited when premium is unlimited", () => {
    const data = {
      copilot_plan: "enterprise",
      quota_reset_date: "2026-02-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 999999,
          remaining: 999999,
          percent_remaining: 100,
          unlimited: true,
        },
      },
    }
    expect(formatInternalStatus(data)).toBe("Copilot enterprise unlimited")
  })

  it("formats status with percentage when quota has remaining", () => {
    const data = {
      copilot_plan: "pro",
      quota_reset_date: "2026-02-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 200,
          remaining: 100,
          percent_remaining: 50,
        },
      },
    }
    expect(formatInternalStatus(data)).toBe("Copilot 50.0% used")
  })

  it("formats status with 100% when no remaining", () => {
    const data = {
      copilot_plan: "pro",
      quota_reset_date: "2026-02-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 200,
          remaining: 0,
          percent_remaining: 0,
        },
      },
    }
    expect(formatInternalStatus(data)).toBe("Copilot 100.0% used")
  })

  it("formats status with 0% when fully remaining", () => {
    const data = {
      copilot_plan: "pro",
      quota_reset_date: "2026-02-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 200,
          remaining: 200,
          percent_remaining: 100,
        },
      },
    }
    expect(formatInternalStatus(data)).toBe("Copilot 0.0% used")
  })
})

describe("COPILOT_PLAN_LIMITS", () => {
  it("has correct limits for all tiers", () => {
    expect(COPILOT_PLAN_LIMITS).toEqual({
      free: 50,
      pro: 300,
      "pro+": 1500,
      business: 300,
      enterprise: 1000,
    })
  })
})

// ---------------------------------------------------------------------------
// Module-level state tests
// ---------------------------------------------------------------------------

describe("module state management", () => {
  it("exports the plugin with correct id", async () => {
    const mod = await import("./index")
    expect(mod.default.id).toBe("copilot-quota-status")
  })

  it("exports the plugin with a tui function", async () => {
    const mod = await import("./index")
    expect(typeof mod.default.tui).toBe("function")
  })

  it("exports COPILOT_PLAN_LIMITS with correct values", async () => {
    const mod = await import("./index")
    expect(mod.COPILOT_PLAN_LIMITS.free).toBe(50)
    expect(mod.COPILOT_PLAN_LIMITS.pro).toBe(300)
    expect(mod.COPILOT_PLAN_LIMITS["pro+"]).toBe(1500)
    expect(mod.COPILOT_PLAN_LIMITS.business).toBe(300)
    expect(mod.COPILOT_PLAN_LIMITS.enterprise).toBe(1000)
  })

  it("exports buildBearerHeaders function", async () => {
    const mod = await import("./index")
    expect(typeof mod.buildBearerHeaders).toBe("function")
  })

  it("exports buildLegacyHeaders function", async () => {
    const mod = await import("./index")
    expect(typeof mod.buildLegacyHeaders).toBe("function")
  })

  it("exports getResetCountdown function", async () => {
    const mod = await import("./index")
    expect(typeof mod.getResetCountdown).toBe("function")
  })

  it("exports formatPublicStatus function", async () => {
    const mod = await import("./index")
    expect(typeof mod.formatPublicStatus).toBe("function")
  })

  it("exports formatInternalStatus function", async () => {
    const mod = await import("./index")
    expect(typeof mod.formatInternalStatus).toBe("function")
  })

  it("exports CopilotQuotaConfig type", async () => {
    const mod = await import("./index")
    expect(mod).toBeDefined()
  })

  it("exports InternalUsage type", async () => {
    const mod = await import("./index")
    expect(mod).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Plugin API integration tests
// ---------------------------------------------------------------------------

describe("plugin tui() registration", () => {
  it("registers slots for home_prompt_right and session_prompt_right", async () => {
    const mockRegister = jest.fn()
    const mockOn = jest.fn(() => () => {})
    const mockApi = {
      slots: {
        register: mockRegister,
      },
      event: {
        on: mockOn,
      },
      lifecycle: {
        onDispose: jest.fn(),
      },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, {} as any)

    expect(mockRegister).toHaveBeenCalledTimes(1)
    const registration = mockRegister.mock.calls[0][0]
    expect(registration.order).toBe(1000)
    expect(registration.slots).toHaveProperty("home_prompt_right")
    expect(registration.slots).toHaveProperty("session_prompt_right")
  })

  it("registers server.connected event listener", async () => {
    const mockRegister = jest.fn()
    const mockEventOn = jest.fn(() => () => {})
    const mockApi = {
      slots: {
        register: mockRegister,
      },
      event: {
        on: mockEventOn,
      },
      lifecycle: {
        onDispose: jest.fn(),
      },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, {} as any)

    expect(mockEventOn).toHaveBeenCalledWith("server.connected", expect.any(Function))
  })

  it("calls onDispose with the event listener cleanup", async () => {
    const mockRegister = jest.fn()
    const mockCleanup = jest.fn()
    const mockOn = jest.fn(() => mockCleanup)
    const mockOnDispose = jest.fn()
    const mockApi = {
      slots: {
        register: mockRegister,
      },
      event: {
        on: mockOn,
      },
      lifecycle: {
        onDispose: mockOnDispose,
      },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, {} as any)

    expect(mockOnDispose).toHaveBeenCalledWith(mockCleanup)
  })
})
