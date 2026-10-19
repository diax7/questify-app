import { describe, expect, it } from "vitest";
import {
  addressBucket,
  codePointLength,
  normalizeEmail,
  normalizePassword,
} from "#src/auth/normalize";

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Sara@Najd.SA \n")).toBe("sara@najd.sa");
  });

  it("applies NFKC so full-width letters match plain ones", () => {
    expect(normalizeEmail("ＳＡＲＡ@najd.sa")).toBe("sara@najd.sa");
  });
});

describe("codePointLength", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["كلمة", 4],
    ["😀", 1],
    ["a😀b", 3],
  ])("counts %j as %i", (text, expected) => {
    expect(codePointLength(text)).toBe(expected);
  });
});

describe("normalizePassword", () => {
  it("makes composed and decomposed forms equal", () => {
    expect(normalizePassword(`e${String.fromCodePoint(0x301)}`)).toBe(
      normalizePassword(String.fromCodePoint(0xe9)),
    );
  });

  it("keeps Arabic text and emoji", () => {
    expect(normalizePassword("مرحبا😀")).toBe("مرحبا😀");
  });
});

describe("addressBucket", () => {
  it("keeps an IPv4 address", () => {
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
  });

  it("turns an IPv4-mapped IPv6 address into IPv4", () => {
    expect(addressBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("reduces IPv6 to its /64 prefix, so one customer's addresses share a bucket", () => {
    const a = addressBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const b = addressBucket("2001:0db8:0001:0002:1111:2222:3333:4444");
    expect(a).toBe("2001:0db8:0001:0002::/64");
    expect(b).toBe(a);
  });

  it("expands :: before cutting the prefix", () => {
    expect(addressBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(addressBucket("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("reads a long tail after :: correctly (the zeros fill the gap)", () => {
    expect(addressBucket("1::2:3:4:5:6:7")).toBe("0001:0000:0002:0003::/64");
    expect(addressBucket("1:2::3:4:5:6:7")).toBe("0001:0002:0000:0003::/64");
  });

  it("handles an address with no ::, a leading ::, and a trailing ::", () => {
    expect(addressBucket("1:2:3:4:5:6:7:8")).toBe("0001:0002:0003:0004::/64");
    expect(addressBucket("::2:3:4:5:6:7:8")).toBe("0000:0002:0003:0004::/64");
    expect(addressBucket("1:2:3::")).toBe("0001:0002:0003:0000::/64");
    expect(addressBucket("::")).toBe("0000:0000:0000:0000::/64");
  });

  it("is not fooled by ::ffff: in the middle of an IPv6 address", () => {
    expect(addressBucket("2001:db8::ffff:203.0.113.9")).toBe("2001:0db8:0000:0000::/64");
  });

  it("does not accept text after an IPv4-mapped address", () => {
    expect(addressBucket("::ffff:203.0.113.9x")).toBe("unknown");
  });

  it("separates different /64 prefixes", () => {
    expect(addressBucket("2001:db8:1:2::1")).not.toBe(addressBucket("2001:db8:1:3::1"));
  });

  it("drops an IPv6 zone", () => {
    expect(addressBucket("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });

  it.each(["", "not-an-ip", "999.1.1.1", "1.2.3", "2001:db8::zz"])(
    "puts %j in the shared unknown bucket",
    (value) => {
      expect(addressBucket(value)).toBe("unknown");
    },
  );
});
