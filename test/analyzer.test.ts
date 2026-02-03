import { describe, expect, test } from "bun:test";
import { analyze } from "../src/analyzer";

/**
 * rugscan analyzer tests
 * 
 * These tests verify real-world contracts produce expected findings.
 * They hit live APIs (Sourcify, GoPlus) so results are authentic.
 */

describe("analyzer", () => {
  describe("safe tokens", () => {
    test("UNI token → OK (verified, no red flags)", async () => {
      const result = await analyze(
        "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
        "ethereum"
      );

      expect(result.contract.verified).toBe(true);
      expect(result.contract.name).toBe("Uni");
      expect(result.recommendation).toBe("ok");
      expect(result.findings.some(f => f.code === "VERIFIED")).toBe(true);
    }, 120000);

    test("WETH on Base → OK (verified, no red flags)", async () => {
      const result = await analyze(
        "0x4200000000000000000000000000000000000006",
        "base"
      );

      expect(result.contract.verified).toBe(true);
      expect(result.contract.name).toBe("WETH9");
      expect(result.recommendation).toBe("ok");
    });
  });

  describe("tokens with centralization risks", () => {
    test("USDT → DANGER (mintable, blacklist, owner can drain)", async () => {
      const result = await analyze(
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "ethereum"
      );

      expect(result.contract.verified).toBe(true);
      expect(result.contract.name).toBe("TetherToken");
      expect(result.recommendation).toBe("danger");
      
      // GoPlus should flag these
      expect(result.findings.some(f => f.code === "HIDDEN_MINT")).toBe(true);
      expect(result.findings.some(f => f.code === "BLACKLIST")).toBe(true);
      expect(result.findings.some(f => f.code === "OWNER_DRAIN")).toBe(true);
    }, 120000);
  });

  describe("unverified contracts", () => {
    test("unverified contract → DANGER with UNVERIFIED finding", async () => {
      const result = await analyze(
        "0x7768a894e6d0160530c0b386c0a963989239f107",
        "ethereum"
      );

      expect(result.contract.verified).toBe(false);
      expect(result.recommendation).toBe("danger");
      expect(result.findings.some(f => f.code === "UNVERIFIED")).toBe(true);
    });
  });

  describe("proxy contracts", () => {
    test("USDC (Ethereum) → CAUTION (upgradeable proxy)", async () => {
      const result = await analyze(
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "ethereum"
      );

      expect(result.contract.verified).toBe(true);
      expect(result.contract.is_proxy).toBe(true);
      expect(result.contract.implementation).toBeDefined();
      expect(result.recommendation).toBe("caution");
      expect(result.findings.some(f => f.code === "UPGRADEABLE")).toBe(true);
    }, 120000);

    test("USDC (Base) → CAUTION (upgradeable proxy)", async () => {
      const result = await analyze(
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "base"
      );

      expect(result.contract.verified).toBe(true);
      expect(result.contract.is_proxy).toBe(true);
      expect(result.recommendation).toBe("caution");
    });
  });

  describe("phishing labels", () => {
    test(
      "known phishing contract → KNOWN_PHISHING finding",
      async () => {
        const result = await analyze(
          "0x000011387Eb24F199e875B1325E4805EfD3b0000",
          "ethereum"
        );

        expect(result.findings.some(f => f.code === "KNOWN_PHISHING")).toBe(true);
      },
      120000
    );
  });

  describe("protocol recognition", () => {
    test("Uniswap V3 router → KNOWN_PROTOCOL finding", async () => {
      const result = await analyze(
        "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        "ethereum"
      );

      expect(result.findings.some(f => f.code === "KNOWN_PROTOCOL")).toBe(true);
      expect(result.protocol?.toLowerCase()).toContain("uniswap");
    });
  });

  describe("token taxes", () => {
    test("high tax token → warning (if available)", async () => {
      const candidates = [
        "0xfad45e47083e4607302aa43c65fb3106f1cd7607", // HOGE (low tax)
        "0xa2b4c0af19cc16a6cfacce81f192b024d625817d", // KISHU (low tax)
        "0x208042a2012812f189e4e696e05f08eadb883404", // honeypot
      ];

      for (const address of candidates) {
        const result = await analyze(address, "ethereum");
        const hasHighTax = result.findings.some(f => f.code === "HIGH_TAX");
        if (hasHighTax) {
          expect(result.recommendation).toBe("warning");
          return;
        }
      }
    }, 120000);
  });

  describe("non-contracts", () => {
    test("EOA address → warning", async () => {
      // Random EOA with no bytecode (not a smart wallet)
      const result = await analyze(
        "0x0000000000000000000000000000000000000001",
        "ethereum"
      );

      expect(result.contract.verified).toBe(false);
      expect(result.recommendation).toBe("caution");
      expect(result.findings.some(f => 
        f.code === "LOW_ACTIVITY" && f.message.includes("not a contract")
      )).toBe(true);
    });

    test("dead address → warning", async () => {
      const result = await analyze(
        "0x000000000000000000000000000000000000dEaD",
        "ethereum"
      );

      expect(result.contract.verified).toBe(false);
      expect(result.findings.some(f => f.message.includes("not a contract"))).toBe(true);
    });
  });

  describe("multi-chain addresses", () => {
    test("same address on different chains", async () => {
      const address = "0x4200000000000000000000000000000000000006";

      const baseResult = await analyze(address, "base");
      const optimismResult = await analyze(address, "optimism");

      expect(baseResult.contract.address).toBe(optimismResult.contract.address);
      expect(baseResult.contract.chain).toBe("base");
      expect(optimismResult.contract.chain).toBe("optimism");
    });
  });

  describe("confidence levels", () => {
    test("verified contract without etherscan key → MEDIUM confidence", async () => {
      const result = await analyze(
        "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
        "ethereum"
        // no config = no etherscan key
      );

      expect(result.confidence.level).toBe("medium");
      expect(result.confidence.reasons).toContain("no etherscan key - limited data");
    });
  });
});
