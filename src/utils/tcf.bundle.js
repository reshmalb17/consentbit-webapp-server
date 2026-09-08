var TCFBundle = (() => {
  var Ee = Object.defineProperty;
  var Ce = (l, r, e) =>
    r in l
      ? Ee(l, r, { enumerable: !0, configurable: !0, writable: !0, value: e })
      : (l[r] = e);
  var o = (l, r, e) => Ce(l, typeof r != "symbol" ? r + "" : r, e);
  var I = class extends Error {
    constructor(r) {
      (super(r), (this.name = "DecodingError"));
    }
  };
  var b = class extends Error {
    constructor(r) {
      (super(r), (this.name = "EncodingError"));
    }
  };
  var O = class extends Error {
    constructor(r) {
      (super(r), (this.name = "GVLError"));
    }
  };
  var x = class extends Error {
    constructor(r, e, t = "") {
      (super(`invalid value ${e} passed for ${r} ${t}`),
        (this.name = "TCModelError"));
    }
  };
  var A = class {
    static encode(r) {
      if (!/^[0-1]+$/.test(r)) throw new b("Invalid bitField");
      let e = r.length % this.LCM;
      r += e ? "0".repeat(this.LCM - e) : "";
      let t = "";
      for (let s = 0; s < r.length; s += this.BASIS)
        t += this.DICT[parseInt(r.substr(s, this.BASIS), 2)];
      return t;
    }
    static decode(r) {
      if (!/^[A-Za-z0-9\-_]+$/.test(r))
        throw new I("Invalidly encoded Base64URL string");
      let e = "";
      for (let t = 0; t < r.length; t++) {
        let s = this.REVERSE_DICT.get(r[t]).toString(2);
        e += "0".repeat(this.BASIS - s.length) + s;
      }
      return e;
    }
  };
  (o(
    A,
    "DICT",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  ),
    o(
      A,
      "REVERSE_DICT",
      new Map([
        ["A", 0],
        ["B", 1],
        ["C", 2],
        ["D", 3],
        ["E", 4],
        ["F", 5],
        ["G", 6],
        ["H", 7],
        ["I", 8],
        ["J", 9],
        ["K", 10],
        ["L", 11],
        ["M", 12],
        ["N", 13],
        ["O", 14],
        ["P", 15],
        ["Q", 16],
        ["R", 17],
        ["S", 18],
        ["T", 19],
        ["U", 20],
        ["V", 21],
        ["W", 22],
        ["X", 23],
        ["Y", 24],
        ["Z", 25],
        ["a", 26],
        ["b", 27],
        ["c", 28],
        ["d", 29],
        ["e", 30],
        ["f", 31],
        ["g", 32],
        ["h", 33],
        ["i", 34],
        ["j", 35],
        ["k", 36],
        ["l", 37],
        ["m", 38],
        ["n", 39],
        ["o", 40],
        ["p", 41],
        ["q", 42],
        ["r", 43],
        ["s", 44],
        ["t", 45],
        ["u", 46],
        ["v", 47],
        ["w", 48],
        ["x", 49],
        ["y", 50],
        ["z", 51],
        ["0", 52],
        ["1", 53],
        ["2", 54],
        ["3", 55],
        ["4", 56],
        ["5", 57],
        ["6", 58],
        ["7", 59],
        ["8", 60],
        ["9", 61],
        ["-", 62],
        ["_", 63],
      ]),
    ),
    o(A, "BASIS", 6),
    o(A, "LCM", 24));
  var y = class {
    clone() {
      let r = new this.constructor();
      return (
        Object.keys(this).forEach((t) => {
          let s = this.deepClone(this[t]);
          s !== void 0 && (r[t] = s);
        }),
        r
      );
    }
    deepClone(r) {
      let e = typeof r;
      if (e === "number" || e === "string" || e === "boolean") return r;
      if (r !== null && e === "object") {
        if (typeof r.clone == "function") return r.clone();
        if (r instanceof Date) return new Date(r.getTime());
        if (r[Symbol.iterator] !== void 0) {
          let t = [];
          for (let s of r) t.push(this.deepClone(s));
          return r instanceof Array ? t : new r.constructor(t);
        } else {
          let t = {};
          for (let s in r) r.hasOwnProperty(s) && (t[s] = this.deepClone(r[s]));
          return t;
        }
      }
    }
  };
  var k = class l extends y {
    constructor() {
      super(...arguments);
      o(this, "root", null);
    }
    getRoot() {
      return this.root;
    }
    isEmpty() {
      return !this.root;
    }
    add(e) {
      let t = { value: e, left: null, right: null },
        s;
      if (this.isEmpty()) this.root = t;
      else
        for (s = this.root; ; )
          if (e < s.value)
            if (s.left === null) {
              s.left = t;
              break;
            } else s = s.left;
          else if (e > s.value)
            if (s.right === null) {
              s.right = t;
              break;
            } else s = s.right;
          else break;
    }
    get() {
      let e = [],
        t = this.root;
      for (; t; )
        if (!t.left) (e.push(t.value), (t = t.right));
        else {
          let s = t.left;
          for (; s.right && s.right != t; ) s = s.right;
          s.right == t
            ? ((s.right = null), e.push(t.value), (t = t.right))
            : ((s.right = t), (t = t.left));
        }
      return e;
    }
    contains(e) {
      let t = !1,
        s = this.root;
      for (; s; )
        if (s.value === e) {
          t = !0;
          break;
        } else e > s.value ? (s = s.right) : e < s.value && (s = s.left);
      return t;
    }
    min(e = this.root) {
      let t;
      for (; e; ) e.left ? (e = e.left) : ((t = e.value), (e = null));
      return t;
    }
    max(e = this.root) {
      let t;
      for (; e; ) e.right ? (e = e.right) : ((t = e.value), (e = null));
      return t;
    }
    remove(e, t = this.root) {
      let s = null,
        n = "left";
      for (; t; )
        if (e < t.value) ((s = t), (t = t.left), (n = "left"));
        else if (e > t.value) ((s = t), (t = t.right), (n = "right"));
        else {
          if (!t.left && !t.right) s ? (s[n] = null) : (this.root = null);
          else if (!t.left) s ? (s[n] = t.right) : (this.root = t.right);
          else if (!t.right) s ? (s[n] = t.left) : (this.root = t.left);
          else {
            let c = this.min(t.right);
            (this.remove(c, t.right), (t.value = c));
          }
          t = null;
        }
    }
    static build(e) {
      if (!e || e.length === 0) return null;
      if (e.length === 1) {
        let t = new l();
        return (t.add(e[0]), t);
      } else {
        let t = e.length >> 1,
          s = new l();
        s.add(e[t]);
        let n = s.getRoot();
        if (n) {
          if (t + 1 < e.length) {
            let c = l.build(e.slice(t + 1));
            n.right = c ? c.getRoot() : null;
          }
          if (t - 1 > 0) {
            let c = l.build(e.slice(0, t - 1));
            n.left = c ? c.getRoot() : null;
          }
        }
        return s;
      }
    }
  };
  var U = class U {
    has(r) {
      return U.langSet.has(r);
    }
    forEach(r) {
      U.langSet.forEach(r);
    }
    get size() {
      return U.langSet.size;
    }
  };
  o(
    U,
    "langSet",
    new Set([
      "BG",
      "CA",
      "CS",
      "DA",
      "DE",
      "EL",
      "EN",
      "ES",
      "ET",
      "FI",
      "FR",
      "HR",
      "HU",
      "IT",
      "JA",
      "LT",
      "LV",
      "MT",
      "NL",
      "NO",
      "PL",
      "PT",
      "RO",
      "RU",
      "SK",
      "SL",
      "SV",
      "TR",
      "ZH",
    ]),
  );
  var z = U;
  var i = class {};
  (o(i, "cmpId", "cmpId"),
    o(i, "cmpVersion", "cmpVersion"),
    o(i, "consentLanguage", "consentLanguage"),
    o(i, "consentScreen", "consentScreen"),
    o(i, "created", "created"),
    o(i, "supportOOB", "supportOOB"),
    o(i, "isServiceSpecific", "isServiceSpecific"),
    o(i, "lastUpdated", "lastUpdated"),
    o(i, "numCustomPurposes", "numCustomPurposes"),
    o(i, "policyVersion", "policyVersion"),
    o(i, "publisherCountryCode", "publisherCountryCode"),
    o(i, "publisherCustomConsents", "publisherCustomConsents"),
    o(
      i,
      "publisherCustomLegitimateInterests",
      "publisherCustomLegitimateInterests",
    ),
    o(i, "publisherLegitimateInterests", "publisherLegitimateInterests"),
    o(i, "publisherConsents", "publisherConsents"),
    o(i, "publisherRestrictions", "publisherRestrictions"),
    o(i, "purposeConsents", "purposeConsents"),
    o(i, "purposeLegitimateInterests", "purposeLegitimateInterests"),
    o(i, "purposeOneTreatment", "purposeOneTreatment"),
    o(i, "specialFeatureOptins", "specialFeatureOptins"),
    o(i, "useNonStandardStacks", "useNonStandardStacks"),
    o(i, "vendorConsents", "vendorConsents"),
    o(i, "vendorLegitimateInterests", "vendorLegitimateInterests"),
    o(i, "vendorListVersion", "vendorListVersion"),
    o(i, "vendorsAllowed", "vendorsAllowed"),
    o(i, "vendorsDisclosed", "vendorsDisclosed"),
    o(i, "version", "version"));
  var w;
  (function (l) {
    ((l[(l.NOT_ALLOWED = 0)] = "NOT_ALLOWED"),
      (l[(l.REQUIRE_CONSENT = 1)] = "REQUIRE_CONSENT"),
      (l[(l.REQUIRE_LI = 2)] = "REQUIRE_LI"));
  })(w || (w = {}));
  var $ = class $ extends y {
    constructor(e, t) {
      super();
      o(this, "purposeId_");
      o(this, "restrictionType");
      (e !== void 0 && (this.purposeId = e),
        t !== void 0 && (this.restrictionType = t));
    }
    static unHash(e) {
      let t = e.split(this.hashSeparator),
        s = new $();
      if (t.length !== 2) throw new x("hash", e);
      return (
        (s.purposeId = parseInt(t[0], 10)),
        (s.restrictionType = parseInt(t[1], 10)),
        s
      );
    }
    get hash() {
      if (!this.isValid())
        throw new Error("cannot hash invalid PurposeRestriction");
      return `${this.purposeId}${$.hashSeparator}${this.restrictionType}`;
    }
    get purposeId() {
      return this.purposeId_;
    }
    set purposeId(e) {
      this.purposeId_ = e;
    }
    isValid() {
      return (
        Number.isInteger(this.purposeId) &&
        this.purposeId > 0 &&
        (this.restrictionType === w.NOT_ALLOWED ||
          this.restrictionType === w.REQUIRE_CONSENT ||
          this.restrictionType === w.REQUIRE_LI)
      );
    }
    isSameAs(e) {
      return (
        this.purposeId === e.purposeId &&
        this.restrictionType === e.restrictionType
      );
    }
  };
  o($, "hashSeparator", "-");
  var T = $;
  var F = class extends y {
    constructor() {
      super(...arguments);
      o(this, "bitLength", 0);
      o(this, "map", new Map());
      o(this, "gvl_");
    }
    has(e) {
      return this.map.has(e);
    }
    isOkToHave(e, t, s) {
      var c;
      let n = !0;
      if ((c = this.gvl) != null && c.vendors) {
        let p = this.gvl.vendors[s];
        if (p)
          if (e === w.NOT_ALLOWED)
            n = p.legIntPurposes.includes(t) || p.purposes.includes(t);
          else if (p.flexiblePurposes.length)
            switch (e) {
              case w.REQUIRE_CONSENT:
                n =
                  p.flexiblePurposes.includes(t) &&
                  p.legIntPurposes.includes(t);
                break;
              case w.REQUIRE_LI:
                n = p.flexiblePurposes.includes(t) && p.purposes.includes(t);
                break;
            }
          else n = !1;
        else n = !1;
      }
      return n;
    }
    add(e, t) {
      if (this.isOkToHave(t.restrictionType, t.purposeId, e)) {
        let s = t.hash;
        (this.has(s) || (this.map.set(s, new k()), (this.bitLength = 0)),
          this.map.get(s).add(e));
      }
    }
    restrictPurposeToLegalBasis(e) {
      let t = this.gvl.vendorIds,
        s = e.hash,
        n = (function () {
          let p;
          for (p of t);
          return p;
        })(),
        c = [...Array(n).keys()].map((p) => p + 1);
      for (let p = 1; p <= n; p++)
        (this.has(s) || (this.map.set(s, k.build(c)), (this.bitLength = 0)),
          this.map.get(s).add(p));
    }
    getVendors(e) {
      let t = [];
      if (e) {
        let s = e.hash;
        this.has(s) && (t = this.map.get(s).get());
      } else {
        let s = new Set();
        (this.map.forEach((n) => {
          n.get().forEach((c) => {
            s.add(c);
          });
        }),
          (t = Array.from(s)));
      }
      return t;
    }
    getRestrictionType(e, t) {
      let s;
      return (
        this.getRestrictions(e).forEach((n) => {
          n.purposeId === t &&
            (s === void 0 || s > n.restrictionType) &&
            (s = n.restrictionType);
        }),
        s
      );
    }
    vendorHasRestriction(e, t) {
      let s = !1,
        n = this.getRestrictions(e);
      for (let c = 0; c < n.length && !s; c++) s = t.isSameAs(n[c]);
      return s;
    }
    getMaxVendorId() {
      let e = 0;
      return (
        this.map.forEach((t) => {
          e = Math.max(t.max(), e);
        }),
        e
      );
    }
    getRestrictions(e) {
      let t = [];
      return (
        this.map.forEach((s, n) => {
          e ? s.contains(e) && t.push(T.unHash(n)) : t.push(T.unHash(n));
        }),
        t
      );
    }
    getPurposes() {
      let e = new Set();
      return (
        this.map.forEach((t, s) => {
          e.add(T.unHash(s).purposeId);
        }),
        Array.from(e)
      );
    }
    remove(e, t) {
      let s = t.hash,
        n = this.map.get(s);
      n &&
        (n.remove(e),
        n.isEmpty() && (this.map.delete(s), (this.bitLength = 0)));
    }
    set gvl(e) {
      this.gvl_ ||
        ((this.gvl_ = e),
        this.map.forEach((t, s) => {
          let n = T.unHash(s);
          t.get().forEach((p) => {
            this.isOkToHave(n.restrictionType, n.purposeId, p) || t.remove(p);
          });
        }));
    }
    get gvl() {
      return this.gvl_;
    }
    isEmpty() {
      return this.map.size === 0;
    }
    get numRestrictions() {
      return this.map.size;
    }
  };
  var Z;
  (function (l) {
    ((l.COOKIE = "cookie"), (l.WEB = "web"), (l.APP = "app"));
  })(Z || (Z = {}));
  var g;
  (function (l) {
    ((l.CORE = "core"),
      (l.VENDORS_DISCLOSED = "vendorsDisclosed"),
      (l.VENDORS_ALLOWED = "vendorsAllowed"),
      (l.PUBLISHER_TC = "publisherTC"));
  })(g || (g = {}));
  var _ = class {};
  (o(_, "ID_TO_KEY", [
    g.CORE,
    g.VENDORS_DISCLOSED,
    g.VENDORS_ALLOWED,
    g.PUBLISHER_TC,
  ]),
    o(_, "KEY_TO_ID", {
      [g.CORE]: 0,
      [g.VENDORS_DISCLOSED]: 1,
      [g.VENDORS_ALLOWED]: 2,
      [g.PUBLISHER_TC]: 3,
    }));
  var S = class extends y {
    constructor() {
      super(...arguments);
      o(this, "bitLength", 0);
      o(this, "maxId_", 0);
      o(this, "set_", new Set());
    }
    *[Symbol.iterator]() {
      for (let e = 1; e <= this.maxId; e++) yield [e, this.has(e)];
    }
    values() {
      return this.set_.values();
    }
    get maxId() {
      return this.maxId_;
    }
    has(e) {
      return this.set_.has(e);
    }
    unset(e) {
      Array.isArray(e)
        ? e.forEach((t) => this.unset(t))
        : typeof e == "object"
          ? this.unset(Object.keys(e).map((t) => Number(t)))
          : (this.set_.delete(Number(e)),
            (this.bitLength = 0),
            e === this.maxId &&
              ((this.maxId_ = 0),
              this.set_.forEach((t) => {
                this.maxId_ = Math.max(this.maxId, t);
              })));
    }
    isIntMap(e) {
      let t = typeof e == "object";
      return (
        (t =
          t &&
          Object.keys(e).every((s) => {
            let n = Number.isInteger(parseInt(s, 10));
            return (
              (n = n && this.isValidNumber(e[s].id)),
              (n = n && e[s].name !== void 0),
              n
            );
          })),
        t
      );
    }
    isValidNumber(e) {
      return parseInt(e, 10) > 0;
    }
    isSet(e) {
      let t = !1;
      return (
        e instanceof Set && (t = Array.from(e).every(this.isValidNumber)),
        t
      );
    }
    set(e) {
      if (Array.isArray(e)) e.forEach((t) => this.set(t));
      else if (this.isSet(e)) this.set(Array.from(e));
      else if (this.isIntMap(e)) this.set(Object.keys(e).map((t) => Number(t)));
      else if (this.isValidNumber(e))
        (this.set_.add(e),
          (this.maxId_ = Math.max(this.maxId, e)),
          (this.bitLength = 0));
      else
        throw new x(
          "set()",
          e,
          "must be positive integer array, positive integer, Set<number>, or IntMap",
        );
    }
    empty() {
      this.set_ = new Set();
    }
    forEach(e) {
      for (let t = 1; t <= this.maxId; t++) e(this.has(t), t);
    }
    get size() {
      return this.set_.size;
    }
    setAll(e) {
      this.set(e);
    }
  };
  var B, ee, te, se, re, oe, ie, ne, ae, pe, ce, le, ue, de, he, fe, me, ge;
  ((ge = i.cmpId),
    (me = i.cmpVersion),
    (fe = i.consentLanguage),
    (he = i.consentScreen),
    (de = i.created),
    (ue = i.isServiceSpecific),
    (le = i.lastUpdated),
    (ce = i.policyVersion),
    (pe = i.publisherCountryCode),
    (ae = i.publisherLegitimateInterests),
    (ne = i.publisherConsents),
    (ie = i.purposeConsents),
    (oe = i.purposeLegitimateInterests),
    (re = i.purposeOneTreatment),
    (se = i.specialFeatureOptins),
    (te = i.useNonStandardStacks),
    (ee = i.vendorListVersion),
    (B = i.version));
  var a = class {};
  (o(a, ge, 12),
    o(a, me, 12),
    o(a, fe, 12),
    o(a, he, 6),
    o(a, de, 36),
    o(a, ue, 1),
    o(a, le, 36),
    o(a, ce, 6),
    o(a, pe, 12),
    o(a, ae, 24),
    o(a, ne, 24),
    o(a, ie, 24),
    o(a, oe, 24),
    o(a, re, 1),
    o(a, se, 12),
    o(a, te, 1),
    o(a, ee, 12),
    o(a, B, 6),
    o(a, "anyBoolean", 1),
    o(a, "encodingType", 1),
    o(a, "maxId", 16),
    o(a, "numCustomPurposes", 6),
    o(a, "numEntries", 12),
    o(a, "numRestrictions", 12),
    o(a, "purposeId", 6),
    o(a, "restrictionType", 2),
    o(a, "segmentType", 3),
    o(a, "singleOrRange", 1),
    o(a, "vendorId", 16));
  var v = class {
    static encode(r) {
      return String(Number(r));
    }
    static decode(r) {
      return r === "1";
    }
  };
  var u = class {
    static encode(r, e) {
      let t;
      if (
        (typeof r == "string" && (r = parseInt(r, 10)),
        (t = r.toString(2)),
        t.length > e || r < 0)
      )
        throw new b(`${r} too large to encode into ${e}`);
      return (t.length < e && (t = "0".repeat(e - t.length) + t), t);
    }
    static decode(r, e) {
      if (e !== r.length) throw new I("invalid bit length");
      return parseInt(r, 2);
    }
  };
  var M = class {
    static encode(r, e) {
      return u.encode(Math.round(r.getTime() / 100), e);
    }
    static decode(r, e) {
      if (e !== r.length) throw new I("invalid bit length");
      let t = new Date();
      return (t.setTime(u.decode(r, e) * 100), t);
    }
  };
  var L = class {
    static encode(r, e) {
      let t = "";
      for (let s = 1; s <= e; s++) t += v.encode(r.has(s));
      return t;
    }
    static decode(r, e) {
      if (r.length !== e) throw new I("bitfield encoding length mismatch");
      let t = new S();
      for (let s = 1; s <= e; s++) v.decode(r[s - 1]) && t.set(s);
      return ((t.bitLength = r.length), t);
    }
  };
  var W = class {
    static encode(r, e) {
      r = r.toUpperCase();
      let t = 65,
        s = r.charCodeAt(0) - t,
        n = r.charCodeAt(1) - t;
      if (s < 0 || s > 25 || n < 0 || n > 25)
        throw new b(`invalid language code: ${r}`);
      if (e % 2 === 1) throw new b(`numBits must be even, ${e} is not valid`);
      e = e / 2;
      let c = u.encode(s, e),
        p = u.encode(n, e);
      return c + p;
    }
    static decode(r, e) {
      let t;
      if (e === r.length && !(r.length % 2)) {
        let n = r.length / 2,
          c = u.decode(r.slice(0, n), n) + 65,
          p = u.decode(r.slice(n), n) + 65;
        t = String.fromCharCode(c) + String.fromCharCode(p);
      } else throw new I("invalid bit length for language");
      return t;
    }
  };
  var Q = class {
    static encode(r) {
      let e = u.encode(r.numRestrictions, a.numRestrictions);
      return (
        r.isEmpty() ||
          r.getRestrictions().forEach((t) => {
            ((e += u.encode(t.purposeId, a.purposeId)),
              (e += u.encode(t.restrictionType, a.restrictionType)));
            let s = r.getVendors(t),
              n = s.length,
              c = 0,
              p = 0,
              h = "";
            for (let m = 0; m < n; m++) {
              let f = s[m];
              p === 0 && (c++, (p = f));
              let C = s[n - 1],
                E = r.gvl.vendorIds,
                N = (V) => {
                  for (; ++V <= C && !E.has(V); );
                  return V;
                };
              if (m === n - 1 || s[m + 1] > N(f)) {
                let V = f !== p;
                ((h += v.encode(V)),
                  (h += u.encode(p, a.vendorId)),
                  V && (h += u.encode(f, a.vendorId)),
                  (p = 0));
              }
            }
            ((e += u.encode(c, a.numEntries)), (e += h));
          }),
        e
      );
    }
    static decode(r) {
      let e = 0,
        t = new F(),
        s = u.decode(r.substr(e, a.numRestrictions), a.numRestrictions);
      e += a.numRestrictions;
      for (let n = 0; n < s; n++) {
        let c = u.decode(r.substr(e, a.purposeId), a.purposeId);
        e += a.purposeId;
        let p = u.decode(r.substr(e, a.restrictionType), a.restrictionType);
        e += a.restrictionType;
        let h = new T(c, p),
          m = u.decode(r.substr(e, a.numEntries), a.numEntries);
        e += a.numEntries;
        for (let f = 0; f < m; f++) {
          let C = v.decode(r.substr(e, a.anyBoolean));
          e += a.anyBoolean;
          let E = u.decode(r.substr(e, a.vendorId), a.vendorId);
          if (((e += a.vendorId), C)) {
            let N = u.decode(r.substr(e, a.vendorId), a.vendorId);
            if (((e += a.vendorId), N < E))
              throw new I(
                `Invalid RangeEntry: endVendorId ${N} is less than ${E}`,
              );
            for (let V = E; V <= N; V++) t.add(V, h);
          } else t.add(E, h);
        }
      }
      return ((t.bitLength = e), t);
    }
  };
  var H;
  (function (l) {
    ((l[(l.FIELD = 0)] = "FIELD"), (l[(l.RANGE = 1)] = "RANGE"));
  })(H || (H = {}));
  var R = class {
    static encode(r) {
      let e = [],
        t = [],
        s = u.encode(r.maxId, a.maxId),
        n = "",
        c,
        p = a.maxId + a.encodingType,
        h = p + r.maxId,
        m = a.vendorId * 2 + a.singleOrRange + a.numEntries,
        f = p + a.numEntries;
      return (
        r.forEach((C, E) => {
          ((n += v.encode(C)),
            (c = r.maxId > m && f < h),
            c &&
              C &&
              (r.has(E + 1)
                ? t.length === 0 &&
                  (t.push(E), (f += a.singleOrRange), (f += a.vendorId))
                : (t.push(E), (f += a.vendorId), e.push(t), (t = []))));
        }),
        c
          ? ((s += String(H.RANGE)), (s += this.buildRangeEncoding(e)))
          : ((s += String(H.FIELD)), (s += n)),
        s
      );
    }
    static decode(r, e) {
      let t,
        s = 0,
        n = u.decode(r.substr(s, a.maxId), a.maxId);
      s += a.maxId;
      let c = u.decode(r.charAt(s), a.encodingType);
      if (((s += a.encodingType), c === H.RANGE)) {
        if (((t = new S()), e === 1)) {
          if (r.substr(s, 1) === "1")
            throw new I("Unable to decode default consent=1");
          s++;
        }
        let p = u.decode(r.substr(s, a.numEntries), a.numEntries);
        s += a.numEntries;
        for (let h = 0; h < p; h++) {
          let m = v.decode(r.charAt(s));
          s += a.singleOrRange;
          let f = u.decode(r.substr(s, a.vendorId), a.vendorId);
          if (((s += a.vendorId), m)) {
            let C = u.decode(r.substr(s, a.vendorId), a.vendorId);
            s += a.vendorId;
            for (let E = f; E <= C; E++) t.set(E);
          } else t.set(f);
        }
      } else {
        let p = r.substr(s, n);
        ((s += n), (t = L.decode(p, n)));
      }
      return ((t.bitLength = s), t);
    }
    static buildRangeEncoding(r) {
      let e = r.length,
        t = u.encode(e, a.numEntries);
      return (
        r.forEach((s) => {
          let n = s.length === 1;
          ((t += v.encode(!n)),
            (t += u.encode(s[0], a.vendorId)),
            n || (t += u.encode(s[1], a.vendorId)));
        }),
        t
      );
    }
  };
  function X() {
    return {
      [i.version]: u,
      [i.created]: M,
      [i.lastUpdated]: M,
      [i.cmpId]: u,
      [i.cmpVersion]: u,
      [i.consentScreen]: u,
      [i.consentLanguage]: W,
      [i.vendorListVersion]: u,
      [i.policyVersion]: u,
      [i.isServiceSpecific]: v,
      [i.useNonStandardStacks]: v,
      [i.specialFeatureOptins]: L,
      [i.purposeConsents]: L,
      [i.purposeLegitimateInterests]: L,
      [i.purposeOneTreatment]: v,
      [i.publisherCountryCode]: W,
      [i.vendorConsents]: R,
      [i.vendorLegitimateInterests]: R,
      [i.publisherRestrictions]: Q,
      segmentType: u,
      [i.vendorsDisclosed]: R,
      [i.vendorsAllowed]: R,
      [i.publisherConsents]: L,
      [i.publisherLegitimateInterests]: L,
      [i.numCustomPurposes]: u,
      [i.publisherCustomConsents]: L,
      [i.publisherCustomLegitimateInterests]: L,
    };
  }
  var Y = class {
    constructor() {
      o(this, 1, {
        [g.CORE]: [
          i.version,
          i.created,
          i.lastUpdated,
          i.cmpId,
          i.cmpVersion,
          i.consentScreen,
          i.consentLanguage,
          i.vendorListVersion,
          i.purposeConsents,
          i.vendorConsents,
        ],
      });
      o(this, 2, {
        [g.CORE]: [
          i.version,
          i.created,
          i.lastUpdated,
          i.cmpId,
          i.cmpVersion,
          i.consentScreen,
          i.consentLanguage,
          i.vendorListVersion,
          i.policyVersion,
          i.isServiceSpecific,
          i.useNonStandardStacks,
          i.specialFeatureOptins,
          i.purposeConsents,
          i.purposeLegitimateInterests,
          i.purposeOneTreatment,
          i.publisherCountryCode,
          i.vendorConsents,
          i.vendorLegitimateInterests,
          i.publisherRestrictions,
        ],
        [g.PUBLISHER_TC]: [
          i.publisherConsents,
          i.publisherLegitimateInterests,
          i.numCustomPurposes,
          i.publisherCustomConsents,
          i.publisherCustomLegitimateInterests,
        ],
        [g.VENDORS_ALLOWED]: [i.vendorsAllowed],
        [g.VENDORS_DISCLOSED]: [i.vendorsDisclosed],
      });
    }
  };
  var q = class {
    constructor(r, e) {
      o(this, 1, [g.CORE]);
      o(this, 2, [g.CORE]);
      if (r.version === 2)
        if (r.isServiceSpecific) this[2].push(g.PUBLISHER_TC);
        else {
          let t = !!(e && e.isForVendors);
          ((!t || r[i.supportOOB] === !0) && this[2].push(g.VENDORS_DISCLOSED),
            t &&
              (r[i.supportOOB] &&
                r[i.vendorsAllowed].size > 0 &&
                this[2].push(g.VENDORS_ALLOWED),
              this[2].push(g.PUBLISHER_TC)));
        }
    }
  };
  var G = class {
    static encode(r, e) {
      let t;
      try {
        t = this.fieldSequence[String(r.version)][e];
      } catch (c) {
        throw new b(`Unable to encode version: ${r.version}, segment: ${e}`);
      }
      let s = "";
      e !== g.CORE && (s = u.encode(_.KEY_TO_ID[e], a.segmentType));
      let n = X();
      return (
        t.forEach((c) => {
          let p = r[c],
            h = n[c],
            m = a[c];
          m === void 0 &&
            this.isPublisherCustom(c) &&
            (m = Number(r[i.numCustomPurposes]));
          try {
            s += h.encode(p, m);
          } catch (f) {
            throw new b(`Error encoding ${e}->${c}: ${f.message}`);
          }
        }),
        A.encode(s)
      );
    }
    static decode(r, e, t) {
      let s = A.decode(r),
        n = 0;
      (t === g.CORE &&
        (e.version = u.decode(s.substr(n, a[i.version]), a[i.version])),
        t !== g.CORE && (n += a.segmentType));
      let c = this.fieldSequence[String(e.version)][t],
        p = X();
      return (
        c.forEach((h) => {
          let m = p[h],
            f = a[h];
          if (
            (f === void 0 &&
              this.isPublisherCustom(h) &&
              (f = Number(e[i.numCustomPurposes])),
            f !== 0)
          ) {
            let C = s.substr(n, f);
            if (
              (m === R
                ? (e[h] = m.decode(C, e.version))
                : (e[h] = m.decode(C, f)),
              Number.isInteger(f))
            )
              n += f;
            else if (Number.isInteger(e[h].bitLength)) n += e[h].bitLength;
            else throw new I(h);
          }
        }),
        e
      );
    }
    static isPublisherCustom(r) {
      return r.indexOf("publisherCustom") === 0;
    }
  };
  o(G, "fieldSequence", new Y());
  var J = class {
    static process(r, e) {
      let t = r.gvl;
      if (!t) throw new b("Unable to encode TCModel without a GVL");
      if (!t.isReady)
        throw new b(
          "Unable to encode TCModel tcModel.gvl.readyPromise is not resolved",
        );
      ((r = r.clone()),
        (r.consentLanguage = t.language.toUpperCase()),
        (e == null ? void 0 : e.version) > 0 &&
        (e == null ? void 0 : e.version) <= this.processor.length
          ? (r.version = e.version)
          : (r.version = this.processor.length));
      let s = r.version - 1;
      if (!this.processor[s]) throw new b(`Invalid version: ${r.version}`);
      return this.processor[s](r, t);
    }
  };
  o(J, "processor", [
    (r) => r,
    (r, e) => {
      ((r.publisherRestrictions.gvl = e),
        r.purposeLegitimateInterests.unset(1));
      let t = new Map();
      return (
        t.set("legIntPurposes", r.vendorLegitimateInterests),
        t.set("purposes", r.vendorConsents),
        t.forEach((s, n) => {
          s.forEach((c, p) => {
            if (c) {
              let h = e.vendors[p];
              if (!h || h.deletedDate) s.unset(p);
              else if (
                h[n].length === 0 &&
                !(
                  n === "legIntPurposes" &&
                  h.purposes.length === 0 &&
                  h.legIntPurposes.length === 0 &&
                  h.specialPurposes.length > 0
                )
              )
                if (r.isServiceSpecific)
                  if (h.flexiblePurposes.length === 0) s.unset(p);
                  else {
                    let m = r.publisherRestrictions.getRestrictions(p),
                      f = !1;
                    for (let C = 0, E = m.length; C < E && !f; C++)
                      f =
                        (m[C].restrictionType === w.REQUIRE_CONSENT &&
                          n === "purposes") ||
                        (m[C].restrictionType === w.REQUIRE_LI &&
                          n === "legIntPurposes");
                    f || s.unset(p);
                  }
                else s.unset(p);
            }
          });
        }),
        r.vendorsDisclosed.set(e.vendors),
        r
      );
    },
  ]);
  var j = class {
    static absCall(r, e, t, s) {
      return new Promise((n, c) => {
        let p = new XMLHttpRequest(),
          h = () => {
            if (p.readyState == XMLHttpRequest.DONE)
              if (p.status >= 200 && p.status < 300) {
                let E = p.response;
                if (typeof E == "string")
                  try {
                    E = JSON.parse(E);
                  } catch (N) {}
                n(E);
              } else
                c(
                  new Error(
                    `HTTP Status: ${p.status} response type: ${p.responseType}`,
                  ),
                );
          },
          m = () => {
            c(new Error("error"));
          },
          f = () => {
            c(new Error("aborted"));
          },
          C = () => {
            c(new Error("Timeout " + s + "ms " + r));
          };
        ((p.withCredentials = t),
          p.addEventListener("load", h),
          p.addEventListener("error", m),
          p.addEventListener("abort", f),
          e === null ? p.open("GET", r, !0) : p.open("POST", r, !0),
          (p.responseType = "json"),
          (p.timeout = s),
          (p.ontimeout = C),
          p.send(e));
      });
    }
    static post(r, e, t = !1, s = 0) {
      return this.absCall(r, JSON.stringify(e), t, s);
    }
    static fetch(r, e = !1, t = 0) {
      return this.absCall(r, null, e, t);
    }
  };
  var d = class d extends y {
    constructor(e) {
      super();
      o(this, "readyPromise");
      o(this, "gvlSpecificationVersion");
      o(this, "vendorListVersion");
      o(this, "tcfPolicyVersion");
      o(this, "lastUpdated");
      o(this, "purposes");
      o(this, "specialPurposes");
      o(this, "features");
      o(this, "specialFeatures");
      o(this, "isReady_", !1);
      o(this, "vendors_");
      o(this, "vendorIds");
      o(this, "fullVendorList");
      o(this, "byPurposeVendorMap");
      o(this, "bySpecialPurposeVendorMap");
      o(this, "byFeatureVendorMap");
      o(this, "bySpecialFeatureVendorMap");
      o(this, "stacks");
      o(this, "lang_");
      o(this, "isLatest", !1);
      let t = d.baseUrl;
      if (((this.lang_ = d.DEFAULT_LANGUAGE), this.isVendorList(e)))
        (this.populate(e), (this.readyPromise = Promise.resolve()));
      else {
        if (!t) throw new O("must specify GVL.baseUrl before loading GVL json");
        if (e > 0) {
          let s = e;
          d.CACHE.has(s)
            ? (this.populate(d.CACHE.get(s)),
              (this.readyPromise = Promise.resolve()))
            : ((t += d.versionedFilename.replace("[VERSION]", String(s))),
              (this.readyPromise = this.fetchJson(t)));
        } else
          d.CACHE.has(d.LATEST_CACHE_KEY)
            ? (this.populate(d.CACHE.get(d.LATEST_CACHE_KEY)),
              (this.readyPromise = Promise.resolve()))
            : ((this.isLatest = !0),
              (this.readyPromise = this.fetchJson(t + d.latestFilename)));
      }
    }
    static set baseUrl(e) {
      if (/^https?:\/\/vendorlist\.consensu\.org\//.test(e))
        throw new O(
          "Invalid baseUrl!  You may not pull directly from vendorlist.consensu.org and must provide your own cache",
        );
      (e.length > 0 && e[e.length - 1] !== "/" && (e += "/"),
        (this.baseUrl_ = e));
    }
    static get baseUrl() {
      return this.baseUrl_;
    }
    static emptyLanguageCache(e) {
      let t = !1;
      return (
        e === void 0 && d.LANGUAGE_CACHE.size > 0
          ? ((d.LANGUAGE_CACHE = new Map()), (t = !0))
          : typeof e == "string" &&
            this.consentLanguages.has(e.toUpperCase()) &&
            (d.LANGUAGE_CACHE.delete(e.toUpperCase()), (t = !0)),
        t
      );
    }
    static emptyCache(e) {
      let t = !1;
      return (
        Number.isInteger(e) && e >= 0
          ? (d.CACHE.delete(e), (t = !0))
          : e === void 0 && ((d.CACHE = new Map()), (t = !0)),
        t
      );
    }
    cacheLanguage() {
      d.LANGUAGE_CACHE.has(this.lang_) ||
        d.LANGUAGE_CACHE.set(this.lang_, {
          purposes: this.purposes,
          specialPurposes: this.specialPurposes,
          features: this.features,
          specialFeatures: this.specialFeatures,
          stacks: this.stacks,
        });
    }
    async fetchJson(e) {
      try {
        this.populate(await j.fetch(e));
      } catch (t) {
        throw new O(t.message);
      }
    }
    getJson() {
      return JSON.parse(
        JSON.stringify({
          gvlSpecificationVersion: this.gvlSpecificationVersion,
          vendorListVersion: this.vendorListVersion,
          tcfPolicyVersion: this.tcfPolicyVersion,
          lastUpdated: this.lastUpdated,
          purposes: this.purposes,
          specialPurposes: this.specialPurposes,
          features: this.features,
          specialFeatures: this.specialFeatures,
          stacks: this.stacks,
          vendors: this.fullVendorList,
        }),
      );
    }
    async changeLanguage(e) {
      let t = e.toUpperCase();
      if (d.consentLanguages.has(t)) {
        if (t !== this.lang_)
          if (((this.lang_ = t), d.LANGUAGE_CACHE.has(t))) {
            let s = d.LANGUAGE_CACHE.get(t);
            for (let n in s) s.hasOwnProperty(n) && (this[n] = s[n]);
          } else {
            let s = d.baseUrl + d.languageFilename.replace("[LANG]", e);
            try {
              (await this.fetchJson(s), this.cacheLanguage());
            } catch (n) {
              throw new O("unable to load language: " + n.message);
            }
          }
      } else throw new O(`unsupported language ${e}`);
    }
    get language() {
      return this.lang_;
    }
    isVendorList(e) {
      return e !== void 0 && e.vendors !== void 0;
    }
    populate(e) {
      ((this.purposes = e.purposes),
        (this.specialPurposes = e.specialPurposes),
        (this.features = e.features),
        (this.specialFeatures = e.specialFeatures),
        (this.stacks = e.stacks),
        this.isVendorList(e) &&
          ((this.gvlSpecificationVersion = e.gvlSpecificationVersion),
          (this.tcfPolicyVersion = e.tcfPolicyVersion),
          (this.vendorListVersion = e.vendorListVersion),
          (this.lastUpdated = e.lastUpdated),
          typeof this.lastUpdated == "string" &&
            (this.lastUpdated = new Date(this.lastUpdated)),
          (this.vendors_ = e.vendors),
          (this.fullVendorList = e.vendors),
          this.mapVendors(),
          (this.isReady_ = !0),
          this.isLatest && d.CACHE.set(d.LATEST_CACHE_KEY, this.getJson()),
          d.CACHE.has(this.vendorListVersion) ||
            d.CACHE.set(this.vendorListVersion, this.getJson())),
        this.cacheLanguage());
    }
    mapVendors(e) {
      ((this.byPurposeVendorMap = {}),
        (this.bySpecialPurposeVendorMap = {}),
        (this.byFeatureVendorMap = {}),
        (this.bySpecialFeatureVendorMap = {}),
        Object.keys(this.purposes).forEach((t) => {
          this.byPurposeVendorMap[t] = {
            legInt: new Set(),
            consent: new Set(),
            flexible: new Set(),
          };
        }),
        Object.keys(this.specialPurposes).forEach((t) => {
          this.bySpecialPurposeVendorMap[t] = new Set();
        }),
        Object.keys(this.features).forEach((t) => {
          this.byFeatureVendorMap[t] = new Set();
        }),
        Object.keys(this.specialFeatures).forEach((t) => {
          this.bySpecialFeatureVendorMap[t] = new Set();
        }),
        Array.isArray(e) ||
          (e = Object.keys(this.fullVendorList).map((t) => +t)),
        (this.vendorIds = new Set(e)),
        (this.vendors_ = e.reduce((t, s) => {
          let n = this.vendors_[String(s)];
          return (
            n &&
              n.deletedDate === void 0 &&
              (n.purposes.forEach((c) => {
                this.byPurposeVendorMap[String(c)].consent.add(s);
              }),
              n.specialPurposes.forEach((c) => {
                this.bySpecialPurposeVendorMap[String(c)].add(s);
              }),
              n.legIntPurposes.forEach((c) => {
                this.byPurposeVendorMap[String(c)].legInt.add(s);
              }),
              n.flexiblePurposes &&
                n.flexiblePurposes.forEach((c) => {
                  this.byPurposeVendorMap[String(c)].flexible.add(s);
                }),
              n.features.forEach((c) => {
                this.byFeatureVendorMap[String(c)].add(s);
              }),
              n.specialFeatures.forEach((c) => {
                this.bySpecialFeatureVendorMap[String(c)].add(s);
              }),
              (t[s] = n)),
            t
          );
        }, {})));
    }
    getFilteredVendors(e, t, s, n) {
      let c = e.charAt(0).toUpperCase() + e.slice(1),
        p,
        h = {};
      return (
        e === "purpose" && s
          ? (p = this["by" + c + "VendorMap"][String(t)][s])
          : (p =
              this["by" + (n ? "Special" : "") + c + "VendorMap"][String(t)]),
        p.forEach((m) => {
          h[String(m)] = this.vendors[String(m)];
        }),
        h
      );
    }
    getVendorsWithConsentPurpose(e) {
      return this.getFilteredVendors("purpose", e, "consent");
    }
    getVendorsWithLegIntPurpose(e) {
      return this.getFilteredVendors("purpose", e, "legInt");
    }
    getVendorsWithFlexiblePurpose(e) {
      return this.getFilteredVendors("purpose", e, "flexible");
    }
    getVendorsWithSpecialPurpose(e) {
      return this.getFilteredVendors("purpose", e, void 0, !0);
    }
    getVendorsWithFeature(e) {
      return this.getFilteredVendors("feature", e);
    }
    getVendorsWithSpecialFeature(e) {
      return this.getFilteredVendors("feature", e, void 0, !0);
    }
    get vendors() {
      return this.vendors_;
    }
    narrowVendorsTo(e) {
      this.mapVendors(e);
    }
    get isReady() {
      return this.isReady_;
    }
    clone() {
      let e = new d(this.getJson());
      return (
        this.lang_ !== d.DEFAULT_LANGUAGE && e.changeLanguage(this.lang_),
        e
      );
    }
    static isInstanceOf(e) {
      return typeof e == "object" && typeof e.narrowVendorsTo == "function";
    }
  };
  (o(d, "LANGUAGE_CACHE", new Map()),
    o(d, "CACHE", new Map()),
    o(d, "LATEST_CACHE_KEY", 0),
    o(d, "DEFAULT_LANGUAGE", "EN"),
    o(d, "consentLanguages", new z()),
    o(d, "baseUrl_"),
    o(d, "latestFilename", "vendor-list.json"),
    o(d, "versionedFilename", "archives/vendor-list-v[VERSION].json"),
    o(d, "languageFilename", "purposes-[LANG].json"));
  var P = d;
  var D = class extends y {
    constructor(e) {
      super();
      o(this, "isServiceSpecific_", !1);
      o(this, "supportOOB_", !0);
      o(this, "useNonStandardStacks_", !1);
      o(this, "purposeOneTreatment_", !1);
      o(this, "publisherCountryCode_", "AA");
      o(this, "version_", 2);
      o(this, "consentScreen_", 0);
      o(this, "policyVersion_", 2);
      o(this, "consentLanguage_", "EN");
      o(this, "cmpId_", 0);
      o(this, "cmpVersion_", 0);
      o(this, "vendorListVersion_", 0);
      o(this, "numCustomPurposes_", 0);
      o(this, "gvl_");
      o(this, "created");
      o(this, "lastUpdated");
      o(this, "specialFeatureOptins", new S());
      o(this, "purposeConsents", new S());
      o(this, "purposeLegitimateInterests", new S());
      o(this, "publisherConsents", new S());
      o(this, "publisherLegitimateInterests", new S());
      o(this, "publisherCustomConsents", new S());
      o(this, "publisherCustomLegitimateInterests", new S());
      o(this, "customPurposes");
      o(this, "vendorConsents", new S());
      o(this, "vendorLegitimateInterests", new S());
      o(this, "vendorsDisclosed", new S());
      o(this, "vendorsAllowed", new S());
      o(this, "publisherRestrictions", new F());
      (e && (this.gvl = e), this.updated());
    }
    set gvl(e) {
      (P.isInstanceOf(e) || (e = new P(e)),
        (this.gvl_ = e),
        (this.publisherRestrictions.gvl = e));
    }
    get gvl() {
      return this.gvl_;
    }
    set cmpId(e) {
      if (((e = Number(e)), Number.isInteger(e) && e > 1)) this.cmpId_ = e;
      else throw new x("cmpId", e);
    }
    get cmpId() {
      return this.cmpId_;
    }
    set cmpVersion(e) {
      if (((e = Number(e)), Number.isInteger(e) && e > -1))
        this.cmpVersion_ = e;
      else throw new x("cmpVersion", e);
    }
    get cmpVersion() {
      return this.cmpVersion_;
    }
    set consentScreen(e) {
      if (((e = Number(e)), Number.isInteger(e) && e > -1))
        this.consentScreen_ = e;
      else throw new x("consentScreen", e);
    }
    get consentScreen() {
      return this.consentScreen_;
    }
    set consentLanguage(e) {
      this.consentLanguage_ = e;
    }
    get consentLanguage() {
      return this.consentLanguage_;
    }
    set publisherCountryCode(e) {
      if (/^([A-z]){2}$/.test(e)) this.publisherCountryCode_ = e.toUpperCase();
      else throw new x("publisherCountryCode", e);
    }
    get publisherCountryCode() {
      return this.publisherCountryCode_;
    }
    set vendorListVersion(e) {
      if (((e = Number(e) >> 0), e < 0)) throw new x("vendorListVersion", e);
      this.vendorListVersion_ = e;
    }
    get vendorListVersion() {
      return this.gvl ? this.gvl.vendorListVersion : this.vendorListVersion_;
    }
    set policyVersion(e) {
      if (((this.policyVersion_ = parseInt(e, 10)), this.policyVersion_ < 0))
        throw new x("policyVersion", e);
    }
    get policyVersion() {
      return this.gvl ? this.gvl.tcfPolicyVersion : this.policyVersion_;
    }
    set version(e) {
      this.version_ = parseInt(e, 10);
    }
    get version() {
      return this.version_;
    }
    set isServiceSpecific(e) {
      this.isServiceSpecific_ = e;
    }
    get isServiceSpecific() {
      return this.isServiceSpecific_;
    }
    set useNonStandardStacks(e) {
      this.useNonStandardStacks_ = e;
    }
    get useNonStandardStacks() {
      return this.useNonStandardStacks_;
    }
    set supportOOB(e) {
      this.supportOOB_ = e;
    }
    get supportOOB() {
      return this.supportOOB_;
    }
    set purposeOneTreatment(e) {
      this.purposeOneTreatment_ = e;
    }
    get purposeOneTreatment() {
      return this.purposeOneTreatment_;
    }
    setAllVendorConsents() {
      this.vendorConsents.set(this.gvl.vendors);
    }
    unsetAllVendorConsents() {
      this.vendorConsents.empty();
    }
    setAllVendorsDisclosed() {
      this.vendorsDisclosed.set(this.gvl.vendors);
    }
    unsetAllVendorsDisclosed() {
      this.vendorsDisclosed.empty();
    }
    setAllVendorsAllowed() {
      this.vendorsAllowed.set(this.gvl.vendors);
    }
    unsetAllVendorsAllowed() {
      this.vendorsAllowed.empty();
    }
    setAllVendorLegitimateInterests() {
      this.vendorLegitimateInterests.set(this.gvl.vendors);
    }
    unsetAllVendorLegitimateInterests() {
      this.vendorLegitimateInterests.empty();
    }
    setAllPurposeConsents() {
      this.purposeConsents.set(this.gvl.purposes);
    }
    unsetAllPurposeConsents() {
      this.purposeConsents.empty();
    }
    setAllPurposeLegitimateInterests() {
      this.purposeLegitimateInterests.set(this.gvl.purposes);
    }
    unsetAllPurposeLegitimateInterests() {
      this.purposeLegitimateInterests.empty();
    }
    setAllSpecialFeatureOptins() {
      this.specialFeatureOptins.set(this.gvl.specialFeatures);
    }
    unsetAllSpecialFeatureOptins() {
      this.specialFeatureOptins.empty();
    }
    setAll() {
      (this.setAllVendorConsents(),
        this.setAllPurposeLegitimateInterests(),
        this.setAllSpecialFeatureOptins(),
        this.setAllPurposeConsents(),
        this.setAllVendorLegitimateInterests());
    }
    unsetAll() {
      (this.unsetAllVendorConsents(),
        this.unsetAllPurposeLegitimateInterests(),
        this.unsetAllSpecialFeatureOptins(),
        this.unsetAllPurposeConsents(),
        this.unsetAllVendorLegitimateInterests());
    }
    get numCustomPurposes() {
      let e = this.numCustomPurposes_;
      if (typeof this.customPurposes == "object") {
        let t = Object.keys(this.customPurposes).sort(
          (s, n) => Number(s) - Number(n),
        );
        e = parseInt(t.pop(), 10);
      }
      return e;
    }
    set numCustomPurposes(e) {
      if (
        ((this.numCustomPurposes_ = parseInt(e, 10)),
        this.numCustomPurposes_ < 0)
      )
        throw new x("numCustomPurposes", e);
    }
    updated() {
      let e = new Date(),
        t = new Date(
          Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()),
        );
      ((this.created = t), (this.lastUpdated = t));
    }
  };
  o(D, "consentLanguages", P.consentLanguages);
  var K = class {
    static encode(r, e) {
      let t = "",
        s;
      return (
        (r = J.process(r, e)),
        Array.isArray(e == null ? void 0 : e.segments)
          ? (s = e.segments)
          : (s = new q(r, e)["" + r.version]),
        s.forEach((n, c) => {
          let p = "";
          (c < s.length - 1 && (p = "."), (t += G.encode(r, n) + p));
        }),
        t
      );
    }
    static decode(r, e) {
      let t = r.split("."),
        s = t.length;
      e || (e = new D());
      for (let n = 0; n < s; n++) {
        let c = t[n],
          h = A.decode(c.charAt(0)).substr(0, a.segmentType),
          m = _.ID_TO_KEY[u.decode(h, a.segmentType).toString()];
        G.decode(c, e, m);
      }
      return e;
    }
  };
  window.IABTCF = { GVL: P, TCModel: D, TCString: K };
})();
