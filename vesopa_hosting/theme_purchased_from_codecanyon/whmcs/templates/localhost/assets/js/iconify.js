"use strict";

function _classCallCheck(a, n) { if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function"); }
function _defineProperties(e, r) { for (var t = 0; t < r.length; t++) { var o = r[t]; o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, _toPropertyKey(o.key), o); } }
function _createClass(e, r, t) { return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", { writable: !1 }), e; }
function _callSuper(t, o, e) { return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e)); }
function _possibleConstructorReturn(t, e) { if (e && ("object" == _typeof(e) || "function" == typeof e)) return e; if (void 0 !== e) throw new TypeError("Derived constructors may only return object or undefined"); return _assertThisInitialized(t); }
function _assertThisInitialized(e) { if (void 0 === e) throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); return e; }
function _isNativeReflectConstruct() { try { var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {})); } catch (t) {} return (_isNativeReflectConstruct = function _isNativeReflectConstruct() { return !!t; })(); }
function _getPrototypeOf(t) { return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (t) { return t.__proto__ || Object.getPrototypeOf(t); }, _getPrototypeOf(t); }
function _inherits(t, e) { if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function"); t.prototype = Object.create(e && e.prototype, { constructor: { value: t, writable: !0, configurable: !0 } }), Object.defineProperty(t, "prototype", { writable: !1 }), e && _setPrototypeOf(t, e); }
function _setPrototypeOf(t, e) { return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) { return t.__proto__ = e, t; }, _setPrototypeOf(t, e); }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
/**
 * (c) Iconify
 *
 * For the full copyright and license information, please view the license.txt
 * files at https://github.com/iconify/iconify
 *
 * Licensed under MIT.
 *
 * @license MIT
 * @version 2.1.0
 */
!function () {
  "use strict";

  var t = Object.freeze({
      left: 0,
      top: 0,
      width: 16,
      height: 16
    }),
    e = Object.freeze({
      rotate: 0,
      vFlip: !1,
      hFlip: !1
    }),
    n = Object.freeze(_objectSpread(_objectSpread({}, t), e)),
    i = Object.freeze(_objectSpread(_objectSpread({}, n), {}, {
      body: "",
      hidden: !1
    })),
    r = Object.freeze({
      width: null,
      height: null
    }),
    o = Object.freeze(_objectSpread(_objectSpread({}, r), e));
  var s = /[\s,]+/;
  var c = _objectSpread(_objectSpread({}, o), {}, {
    preserveAspectRatio: ""
  });
  function a(t) {
    var e = _objectSpread({}, c),
      n = function n(e, _n) {
        return t.getAttribute(e) || _n;
      };
    var i;
    return e.width = n("width", null), e.height = n("height", null), e.rotate = function (t) {
      var e = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
      var n = t.replace(/^-?[0-9.]*/, "");
      function i(t) {
        for (; t < 0;) t += 4;
        return t % 4;
      }
      if ("" === n) {
        var _e = parseInt(t);
        return isNaN(_e) ? 0 : i(_e);
      }
      if (n !== t) {
        var _e2 = 0;
        switch (n) {
          case "%":
            _e2 = 25;
            break;
          case "deg":
            _e2 = 90;
        }
        if (_e2) {
          var _r = parseFloat(t.slice(0, t.length - n.length));
          return isNaN(_r) ? 0 : (_r /= _e2, _r % 1 == 0 ? i(_r) : 0);
        }
      }
      return e;
    }(n("rotate", "")), i = e, n("flip", "").split(s).forEach(function (t) {
      switch (t.trim()) {
        case "horizontal":
          i.hFlip = !0;
          break;
        case "vertical":
          i.vFlip = !0;
      }
    }), e.preserveAspectRatio = n("preserveAspectRatio", n("preserveaspectratio", "")), e;
  }
  var u = /^[a-z0-9]+(-[a-z0-9]+)*$/,
    l = function l(t, e, n) {
      var i = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : "";
      var r = t.split(":");
      if ("@" === t.slice(0, 1)) {
        if (r.length < 2 || r.length > 3) return null;
        i = r.shift().slice(1);
      }
      if (r.length > 3 || !r.length) return null;
      if (r.length > 1) {
        var _t2 = r.pop(),
          _n2 = r.pop(),
          _o = {
            provider: r.length > 0 ? r[0] : i,
            prefix: _n2,
            name: _t2
          };
        return e && !f(_o) ? null : _o;
      }
      var o = r[0],
        s = o.split("-");
      if (s.length > 1) {
        var _t3 = {
          provider: i,
          prefix: s.shift(),
          name: s.join("-")
        };
        return e && !f(_t3) ? null : _t3;
      }
      if (n && "" === i) {
        var _t4 = {
          provider: i,
          prefix: "",
          name: o
        };
        return e && !f(_t4, n) ? null : _t4;
      }
      return null;
    },
    f = function f(t, e) {
      return !!t && !("" !== t.provider && !t.provider.match(u) || !(e && "" === t.prefix || t.prefix.match(u)) || !t.name.match(u));
    };
  function d(t, n) {
    var r = function (t, e) {
      var n = {};
      !t.hFlip != !e.hFlip && (n.hFlip = !0), !t.vFlip != !e.vFlip && (n.vFlip = !0);
      var i = ((t.rotate || 0) + (e.rotate || 0)) % 4;
      return i && (n.rotate = i), n;
    }(t, n);
    for (var _o2 in i) _o2 in e ? _o2 in t && !(_o2 in r) && (r[_o2] = e[_o2]) : _o2 in n ? r[_o2] = n[_o2] : _o2 in t && (r[_o2] = t[_o2]);
    return r;
  }
  function h(t, e, n) {
    var i = t.icons,
      r = t.aliases || Object.create(null);
    var o = {};
    function s(t) {
      o = d(i[t] || r[t], o);
    }
    return s(e), n.forEach(s), d(t, o);
  }
  function p(t, e) {
    var n = [];
    if ("object" != _typeof(t) || "object" != _typeof(t.icons)) return n;
    t.not_found instanceof Array && t.not_found.forEach(function (t) {
      e(t, null), n.push(t);
    });
    var i = function (t, e) {
      var n = t.icons,
        i = t.aliases || Object.create(null),
        r = Object.create(null);
      return (e || Object.keys(n).concat(Object.keys(i))).forEach(function t(e) {
        if (n[e]) return r[e] = [];
        if (!(e in r)) {
          r[e] = null;
          var _n3 = i[e] && i[e].parent,
            _o3 = _n3 && t(_n3);
          _o3 && (r[e] = [_n3].concat(_o3));
        }
        return r[e];
      }), r;
    }(t);
    for (var _r2 in i) {
      var _o4 = i[_r2];
      _o4 && (e(_r2, h(t, _r2, _o4)), n.push(_r2));
    }
    return n;
  }
  var g = _objectSpread({
    provider: "",
    aliases: {},
    not_found: {}
  }, t);
  function b(t, e) {
    for (var _n4 in e) if (_n4 in t && _typeof(t[_n4]) != _typeof(e[_n4])) return !1;
    return !0;
  }
  function v(t) {
    if ("object" != _typeof(t) || null === t) return null;
    var e = t;
    if ("string" != typeof e.prefix || !t.icons || "object" != _typeof(t.icons)) return null;
    if (!b(t, g)) return null;
    var n = e.icons;
    for (var _t5 in n) {
      var _e3 = n[_t5];
      if (!_t5.match(u) || "string" != typeof _e3.body || !b(_e3, i)) return null;
    }
    var r = e.aliases || Object.create(null);
    for (var _t6 in r) {
      var _e4 = r[_t6],
        _o5 = _e4.parent;
      if (!_t6.match(u) || "string" != typeof _o5 || !n[_o5] && !r[_o5] || !b(_e4, i)) return null;
    }
    return e;
  }
  var m = Object.create(null);
  function y(t, e) {
    var n = m[t] || (m[t] = Object.create(null));
    return n[e] || (n[e] = function (t, e) {
      return {
        provider: t,
        prefix: e,
        icons: Object.create(null),
        missing: new Set()
      };
    }(t, e));
  }
  function x(t, e) {
    return v(e) ? p(e, function (e, n) {
      n ? t.icons[e] = n : t.missing.add(e);
    }) : [];
  }
  function w(t, e) {
    var n = [];
    return ("string" == typeof t ? [t] : Object.keys(m)).forEach(function (t) {
      ("string" == typeof t && "string" == typeof e ? [e] : Object.keys(m[t] || {})).forEach(function (e) {
        var i = y(t, e);
        n = n.concat(Object.keys(i.icons).map(function (n) {
          return ("" !== t ? "@" + t + ":" : "") + e + ":" + n;
        }));
      });
    }), n;
  }
  var _ = !1;
  function k(t) {
    return "boolean" == typeof t && (_ = t), _;
  }
  function j(t) {
    var e = "string" == typeof t ? l(t, !0, _) : t;
    if (e) {
      var _t7 = y(e.provider, e.prefix),
        _n5 = e.name;
      return _t7.icons[_n5] || (_t7.missing.has(_n5) ? null : void 0);
    }
  }
  function A(t, e) {
    var n = l(t, !0, _);
    if (!n) return !1;
    return function (t, e, n) {
      try {
        if ("string" == typeof n.body) return t.icons[e] = _objectSpread({}, n), !0;
      } catch (t) {}
      return !1;
    }(y(n.provider, n.prefix), n.name, e);
  }
  function O(t, e) {
    if ("object" != _typeof(t)) return !1;
    if ("string" != typeof e && (e = t.provider || ""), _ && !e && !t.prefix) {
      var _e5 = !1;
      return v(t) && (t.prefix = "", p(t, function (t, n) {
        n && A(t, n) && (_e5 = !0);
      })), _e5;
    }
    var n = t.prefix;
    if (!f({
      provider: e,
      prefix: n,
      name: "a"
    })) return !1;
    return !!x(y(e, n), t);
  }
  function C(t) {
    return !!j(t);
  }
  function I(t) {
    var e = j(t);
    return e ? _objectSpread(_objectSpread({}, n), e) : null;
  }
  function S(t, e) {
    t.forEach(function (t) {
      var n = t.loaderCallbacks;
      n && (t.loaderCallbacks = n.filter(function (t) {
        return t.id !== e;
      }));
    });
  }
  var E = 0;
  var M = Object.create(null);
  function T(t, e) {
    M[t] = e;
  }
  function F(t) {
    return M[t] || M[""];
  }
  var R = {
    resources: [],
    index: 0,
    timeout: 2e3,
    rotate: 750,
    random: !1,
    dataAfterTimeout: !1
  };
  function L(t, e, n, i) {
    var r = t.resources.length,
      o = t.random ? Math.floor(Math.random() * r) : t.index;
    var s;
    if (t.random) {
      var _e6 = t.resources.slice(0);
      for (s = []; _e6.length > 1;) {
        var _t8 = Math.floor(Math.random() * _e6.length);
        s.push(_e6[_t8]), _e6 = _e6.slice(0, _t8).concat(_e6.slice(_t8 + 1));
      }
      s = s.concat(_e6);
    } else s = t.resources.slice(o).concat(t.resources.slice(0, o));
    var c = Date.now();
    var a,
      u = "pending",
      l = 0,
      f = null,
      d = [],
      h = [];
    function p() {
      f && (clearTimeout(f), f = null);
    }
    function g() {
      "pending" === u && (u = "aborted"), p(), d.forEach(function (t) {
        "pending" === t.status && (t.status = "aborted");
      }), d = [];
    }
    function b(t, e) {
      e && (h = []), "function" == typeof t && h.push(t);
    }
    function v() {
      u = "failed", h.forEach(function (t) {
        t(void 0, a);
      });
    }
    function m() {
      d.forEach(function (t) {
        "pending" === t.status && (t.status = "aborted");
      }), d = [];
    }
    function y() {
      if ("pending" !== u) return;
      p();
      var i = s.shift();
      if (void 0 === i) return d.length ? void (f = setTimeout(function () {
        p(), "pending" === u && (m(), v());
      }, t.timeout)) : void v();
      var r = {
        status: "pending",
        resource: i,
        callback: function callback(e, n) {
          !function (e, n, i) {
            var r = "success" !== n;
            switch (d = d.filter(function (t) {
              return t !== e;
            }), u) {
              case "pending":
                break;
              case "failed":
                if (r || !t.dataAfterTimeout) return;
                break;
              default:
                return;
            }
            if ("abort" === n) return a = i, void v();
            if (r) return a = i, void (d.length || (s.length ? y() : v()));
            if (p(), m(), !t.random) {
              var _n6 = t.resources.indexOf(e.resource);
              -1 !== _n6 && _n6 !== t.index && (t.index = _n6);
            }
            u = "completed", h.forEach(function (t) {
              t(i);
            });
          }(r, e, n);
        }
      };
      d.push(r), l++, f = setTimeout(y, t.rotate), n(i, e, r.callback);
    }
    return "function" == typeof i && h.push(i), setTimeout(y), function () {
      return {
        startTime: c,
        payload: e,
        status: u,
        queriesSent: l,
        queriesPending: d.length,
        subscribe: b,
        abort: g
      };
    };
  }
  function P(t) {
    var e = _objectSpread(_objectSpread({}, R), t);
    var n = [];
    function i() {
      n = n.filter(function (t) {
        return "pending" === t().status;
      });
    }
    return {
      query: function query(t, r, o) {
        var s = L(e, t, r, function (t, e) {
          i(), o && o(t, e);
        });
        return n.push(s), s;
      },
      find: function find(t) {
        return n.find(function (e) {
          return t(e);
        }) || null;
      },
      setIndex: function setIndex(t) {
        e.index = t;
      },
      getIndex: function getIndex() {
        return e.index;
      },
      cleanup: i
    };
  }
  function N(t) {
    var e;
    if ("string" == typeof t.resources) e = [t.resources];else if (e = t.resources, !(e instanceof Array && e.length)) return null;
    return {
      resources: e,
      path: t.path || "/",
      maxURL: t.maxURL || 500,
      rotate: t.rotate || 750,
      timeout: t.timeout || 5e3,
      random: !0 === t.random,
      index: t.index || 0,
      dataAfterTimeout: !1 !== t.dataAfterTimeout
    };
  }
  var z = Object.create(null),
    Q = ["https://api.simplesvg.com", "https://api.unisvg.com"],
    q = [];
  for (; Q.length > 0;) 1 === Q.length || Math.random() > 0.5 ? q.push(Q.shift()) : q.push(Q.pop());
  function D(t, e) {
    var n = N(e);
    return null !== n && (z[t] = n, !0);
  }
  function U(t) {
    return z[t];
  }
  function H() {
    return Object.keys(z);
  }
  function J() {}
  z[""] = N({
    resources: ["https://api.iconify.design"].concat(q)
  });
  var $ = Object.create(null);
  function B(t, e, n) {
    var i, r;
    if ("string" == typeof t) {
      var _e7 = F(t);
      if (!_e7) return n(void 0, 424), J;
      r = _e7.send;
      var _o6 = function (t) {
        if (!$[t]) {
          var _e8 = U(t);
          if (!_e8) return;
          var _n7 = {
            config: _e8,
            redundancy: P(_e8)
          };
          $[t] = _n7;
        }
        return $[t];
      }(t);
      _o6 && (i = _o6.redundancy);
    } else {
      var _e9 = N(t);
      if (_e9) {
        i = P(_e9);
        var _n8 = F(t.resources ? t.resources[0] : "");
        _n8 && (r = _n8.send);
      }
    }
    return i && r ? i.query(e, r, n)().abort : (n(void 0, 424), J);
  }
  var G = "iconify2",
    V = "iconify",
    K = V + "-count",
    W = V + "-version",
    X = 36e5,
    Y = 168,
    Z = 50;
  function tt(t, e) {
    try {
      return t.getItem(e);
    } catch (t) {}
  }
  function et(t, e, n) {
    try {
      return t.setItem(e, n), !0;
    } catch (t) {}
  }
  function nt(t, e) {
    try {
      t.removeItem(e);
    } catch (t) {}
  }
  function it(t, e) {
    return et(t, K, e.toString());
  }
  function rt(t) {
    return parseInt(tt(t, K)) || 0;
  }
  var ot = {
      local: !0,
      session: !0
    },
    st = {
      local: new Set(),
      session: new Set()
    };
  var ct = !1;
  var at = "undefined" == typeof window ? {} : window;
  function ut(t) {
    var e = t + "Storage";
    try {
      if (at && at[e] && "number" == typeof at[e].length) return at[e];
    } catch (t) {}
    ot[t] = !1;
  }
  function lt(t, e) {
    var n = ut(t);
    if (!n) return;
    var i = tt(n, W);
    if (i !== G) {
      if (i) {
        var _t9 = rt(n);
        for (var _e0 = 0; _e0 < _t9; _e0++) nt(n, V + _e0.toString());
      }
      return et(n, W, G), void it(n, 0);
    }
    var r = Math.floor(Date.now() / X) - Y,
      o = function o(t) {
        var i = V + t.toString(),
          o = tt(n, i);
        if ("string" == typeof o) {
          try {
            var _n9 = JSON.parse(o);
            if ("object" == _typeof(_n9) && "number" == typeof _n9.cached && _n9.cached > r && "string" == typeof _n9.provider && "object" == _typeof(_n9.data) && "string" == typeof _n9.data.prefix && e(_n9, t)) return !0;
          } catch (t) {}
          nt(n, i);
        }
      };
    var s = rt(n);
    for (var _e1 = s - 1; _e1 >= 0; _e1--) o(_e1) || (_e1 === s - 1 ? (s--, it(n, s)) : st[t].add(_e1));
  }
  function ft() {
    if (!ct) {
      ct = !0;
      for (var _t0 in ot) lt(_t0, function (t) {
        var e = t.data,
          n = y(t.provider, e.prefix);
        if (!x(n, e).length) return !1;
        var i = e.lastModified || -1;
        return n.lastModifiedCached = n.lastModifiedCached ? Math.min(n.lastModifiedCached, i) : i, !0;
      });
    }
  }
  function dt(t, e) {
    function n(n) {
      var i;
      if (!ot[n] || !(i = ut(n))) return;
      var r = st[n];
      var o;
      if (r.size) r["delete"](o = Array.from(r).shift());else if (o = rt(i), o >= Z || !it(i, o + 1)) return;
      var s = {
        cached: Math.floor(Date.now() / X),
        provider: t.provider,
        data: e
      };
      return et(i, V + o.toString(), JSON.stringify(s));
    }
    ct || ft(), e.lastModified && !function (t, e) {
      var n = t.lastModifiedCached;
      if (n && n >= e) return n === e;
      if (t.lastModifiedCached = e, n) for (var _n0 in ot) lt(_n0, function (n) {
        var i = n.data;
        return n.provider !== t.provider || i.prefix !== t.prefix || i.lastModified === e;
      });
      return !0;
    }(t, e.lastModified) || Object.keys(e.icons).length && (e.not_found && delete (e = Object.assign({}, e)).not_found, n("local") || n("session"));
  }
  function ht() {}
  function pt(t) {
    t.iconsLoaderFlag || (t.iconsLoaderFlag = !0, setTimeout(function () {
      t.iconsLoaderFlag = !1, function (t) {
        t.pendingCallbacksFlag || (t.pendingCallbacksFlag = !0, setTimeout(function () {
          t.pendingCallbacksFlag = !1;
          var e = t.loaderCallbacks ? t.loaderCallbacks.slice(0) : [];
          if (!e.length) return;
          var n = !1;
          var i = t.provider,
            r = t.prefix;
          e.forEach(function (e) {
            var o = e.icons,
              s = o.pending.length;
            o.pending = o.pending.filter(function (e) {
              if (e.prefix !== r) return !0;
              var s = e.name;
              if (t.icons[s]) o.loaded.push({
                provider: i,
                prefix: r,
                name: s
              });else {
                if (!t.missing.has(s)) return n = !0, !0;
                o.missing.push({
                  provider: i,
                  prefix: r,
                  name: s
                });
              }
              return !1;
            }), o.pending.length !== s && (n || S([t], e.id), e.callback(o.loaded.slice(0), o.missing.slice(0), o.pending.slice(0), e.abort));
          });
        }));
      }(t);
    }));
  }
  var gt = function gt(t, e) {
      var n = function (t) {
          var e = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : !0;
          var n = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : !1;
          var i = [];
          return t.forEach(function (t) {
            var r = "string" == typeof t ? l(t, e, n) : t;
            r && i.push(r);
          }), i;
        }(t, !0, k()),
        i = function (t) {
          var e = {
              loaded: [],
              missing: [],
              pending: []
            },
            n = Object.create(null);
          t.sort(function (t, e) {
            return t.provider !== e.provider ? t.provider.localeCompare(e.provider) : t.prefix !== e.prefix ? t.prefix.localeCompare(e.prefix) : t.name.localeCompare(e.name);
          });
          var i = {
            provider: "",
            prefix: "",
            name: ""
          };
          return t.forEach(function (t) {
            if (i.name === t.name && i.prefix === t.prefix && i.provider === t.provider) return;
            i = t;
            var r = t.provider,
              o = t.prefix,
              s = t.name,
              c = n[r] || (n[r] = Object.create(null)),
              a = c[o] || (c[o] = y(r, o));
            var u;
            u = s in a.icons ? e.loaded : "" === o || a.missing.has(s) ? e.missing : e.pending;
            var l = {
              provider: r,
              prefix: o,
              name: s
            };
            u.push(l);
          }), e;
        }(n);
      if (!i.pending.length) {
        var _t1 = !0;
        return e && setTimeout(function () {
          _t1 && e(i.loaded, i.missing, i.pending, ht);
        }), function () {
          _t1 = !1;
        };
      }
      var r = Object.create(null),
        o = [];
      var s, c;
      return i.pending.forEach(function (t) {
        var e = t.provider,
          n = t.prefix;
        if (n === c && e === s) return;
        s = e, c = n, o.push(y(e, n));
        var i = r[e] || (r[e] = Object.create(null));
        i[n] || (i[n] = []);
      }), i.pending.forEach(function (t) {
        var e = t.provider,
          n = t.prefix,
          i = t.name,
          o = y(e, n),
          s = o.pendingIcons || (o.pendingIcons = new Set());
        s.has(i) || (s.add(i), r[e][n].push(i));
      }), o.forEach(function (t) {
        var e = t.provider,
          n = t.prefix;
        r[e][n].length && function (t, e) {
          t.iconsToLoad ? t.iconsToLoad = t.iconsToLoad.concat(e).sort() : t.iconsToLoad = e, t.iconsQueueFlag || (t.iconsQueueFlag = !0, setTimeout(function () {
            t.iconsQueueFlag = !1;
            var e = t.provider,
              n = t.prefix,
              i = t.iconsToLoad;
            var r;
            delete t.iconsToLoad, i && (r = F(e)) && r.prepare(e, n, i).forEach(function (n) {
              B(e, n, function (e) {
                if ("object" != _typeof(e)) n.icons.forEach(function (e) {
                  t.missing.add(e);
                });else try {
                  var _n1 = x(t, e);
                  if (!_n1.length) return;
                  var _i = t.pendingIcons;
                  _i && _n1.forEach(function (t) {
                    _i["delete"](t);
                  }), dt(t, e);
                } catch (t) {
                  console.error(t);
                }
                pt(t);
              });
            });
          }));
        }(t, r[e][n]);
      }), e ? function (t, e, n) {
        var i = E++,
          r = S.bind(null, n, i);
        if (!e.pending.length) return r;
        var o = {
          id: i,
          icons: e,
          callback: t,
          abort: r
        };
        return n.forEach(function (t) {
          (t.loaderCallbacks || (t.loaderCallbacks = [])).push(o);
        }), r;
      }(e, i, o) : ht;
    },
    bt = function bt(t) {
      return new Promise(function (e, i) {
        var r = "string" == typeof t ? l(t, !0) : t;
        r ? gt([r || t], function (o) {
          if (o.length && r) {
            var _t10 = j(r);
            if (_t10) return void e(_objectSpread(_objectSpread({}, n), _t10));
          }
          i(t);
        }) : i(t);
      });
    };
  function vt(t, e) {
    var n = "string" == typeof t ? l(t, !0, !0) : null;
    if (!n) {
      var _e10 = function (t) {
        try {
          var _e11 = "string" == typeof t ? JSON.parse(t) : t;
          if ("string" == typeof _e11.body) return _objectSpread({}, _e11);
        } catch (t) {}
      }(t);
      return {
        value: t,
        data: _e10
      };
    }
    var i = j(n);
    if (void 0 !== i || !n.prefix) return {
      value: t,
      name: n,
      data: i
    };
    var r = gt([n], function () {
      return e(t, n, j(n));
    });
    return {
      value: t,
      name: n,
      loading: r
    };
  }
  var mt = !1;
  try {
    mt = 0 === navigator.vendor.indexOf("Apple");
  } catch (t) {}
  var yt = /(-?[0-9.]*[0-9]+[0-9.]*)/g,
    xt = /^-?[0-9.]*[0-9]+[0-9.]*$/g;
  function wt(t, e, n) {
    if (1 === e) return t;
    if (n = n || 100, "number" == typeof t) return Math.ceil(t * e * n) / n;
    if ("string" != typeof t) return t;
    var i = t.split(yt);
    if (null === i || !i.length) return t;
    var r = [];
    var o = i.shift(),
      s = xt.test(o);
    for (;;) {
      if (s) {
        var _t11 = parseFloat(o);
        isNaN(_t11) ? r.push(o) : r.push(Math.ceil(_t11 * e * n) / n);
      } else r.push(o);
      if (o = i.shift(), void 0 === o) return r.join("");
      s = !s;
    }
  }
  var _t = function _t(t) {
    return "unset" === t || "undefined" === t || "none" === t;
  };
  function kt(t, e) {
    var i = _objectSpread(_objectSpread({}, n), t),
      r = _objectSpread(_objectSpread({}, o), e),
      s = {
        left: i.left,
        top: i.top,
        width: i.width,
        height: i.height
      };
    var c = i.body;
    [i, r].forEach(function (t) {
      var e = [],
        n = t.hFlip,
        i = t.vFlip;
      var r,
        o = t.rotate;
      switch (n ? i ? o += 2 : (e.push("translate(" + (s.width + s.left).toString() + " " + (0 - s.top).toString() + ")"), e.push("scale(-1 1)"), s.top = s.left = 0) : i && (e.push("translate(" + (0 - s.left).toString() + " " + (s.height + s.top).toString() + ")"), e.push("scale(1 -1)"), s.top = s.left = 0), o < 0 && (o -= 4 * Math.floor(o / 4)), o %= 4, o) {
        case 1:
          r = s.height / 2 + s.top, e.unshift("rotate(90 " + r.toString() + " " + r.toString() + ")");
          break;
        case 2:
          e.unshift("rotate(180 " + (s.width / 2 + s.left).toString() + " " + (s.height / 2 + s.top).toString() + ")");
          break;
        case 3:
          r = s.width / 2 + s.left, e.unshift("rotate(-90 " + r.toString() + " " + r.toString() + ")");
      }
      o % 2 == 1 && (s.left !== s.top && (r = s.left, s.left = s.top, s.top = r), s.width !== s.height && (r = s.width, s.width = s.height, s.height = r)), e.length && (c = function (t, e, n) {
        var i = function (t) {
          var e = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : "defs";
          var n = "";
          var i = t.indexOf("<" + e);
          for (; i >= 0;) {
            var _r3 = t.indexOf(">", i),
              _o7 = t.indexOf("</" + e);
            if (-1 === _r3 || -1 === _o7) break;
            var _s = t.indexOf(">", _o7);
            if (-1 === _s) break;
            n += t.slice(_r3 + 1, _o7).trim(), t = t.slice(0, i).trim() + t.slice(_s + 1);
          }
          return {
            defs: n,
            content: t
          };
        }(t);
        return r = i.defs, o = e + i.content + n, r ? "<defs>" + r + "</defs>" + o : o;
        var r, o;
      }(c, '<g transform="' + e.join(" ") + '">', "</g>"));
    });
    var a = r.width,
      u = r.height,
      l = s.width,
      f = s.height;
    var d, h;
    null === a ? (h = null === u ? "1em" : "auto" === u ? f : u, d = wt(h, l / f)) : (d = "auto" === a ? l : a, h = null === u ? wt(d, f / l) : "auto" === u ? f : u);
    var p = {},
      g = function g(t, e) {
        _t(e) || (p[t] = e.toString());
      };
    g("width", d), g("height", h);
    var b = [s.left, s.top, l, f];
    return p.viewBox = b.join(" "), {
      attributes: p,
      viewBox: b,
      body: c
    };
  }
  function jt(t, e) {
    var n = -1 === t.indexOf("xlink:") ? "" : ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    for (var _t12 in e) n += " " + _t12 + '="' + e[_t12] + '"';
    return '<svg xmlns="http://www.w3.org/2000/svg"' + n + ">" + t + "</svg>";
  }
  function At(t) {
    return 'url("' + function (t) {
      return "data:image/svg+xml," + function (t) {
        return t.replace(/"/g, "'").replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\s+/g, " ");
      }(t);
    }(t) + '")';
  }
  var Ot = function () {
    var t;
    try {
      if (t = fetch, "function" == typeof t) return t;
    } catch (t) {}
  }();
  function Ct(t) {
    Ot = t;
  }
  function It() {
    return Ot;
  }
  var St = {
    prepare: function prepare(t, e, n) {
      var i = [],
        r = function (t, e) {
          var n = U(t);
          if (!n) return 0;
          var i;
          if (n.maxURL) {
            var _t13 = 0;
            n.resources.forEach(function (e) {
              var n = e;
              _t13 = Math.max(_t13, n.length);
            });
            var _r4 = e + ".json?icons=";
            i = n.maxURL - _t13 - n.path.length - _r4.length;
          } else i = 0;
          return i;
        }(t, e),
        o = "icons";
      var s = {
          type: o,
          provider: t,
          prefix: e,
          icons: []
        },
        c = 0;
      return n.forEach(function (n, a) {
        c += n.length + 1, c >= r && a > 0 && (i.push(s), s = {
          type: o,
          provider: t,
          prefix: e,
          icons: []
        }, c = n.length), s.icons.push(n);
      }), i.push(s), i;
    },
    send: function send(t, e, n) {
      if (!Ot) return void n("abort", 424);
      var i = function (t) {
        if ("string" == typeof t) {
          var _e12 = U(t);
          if (_e12) return _e12.path;
        }
        return "/";
      }(e.provider);
      switch (e.type) {
        case "icons":
          {
            var _t14 = e.prefix,
              _n10 = e.icons.join(",");
            i += _t14 + ".json?" + new URLSearchParams({
              icons: _n10
            }).toString();
            break;
          }
        case "custom":
          {
            var _t15 = e.uri;
            i += "/" === _t15.slice(0, 1) ? _t15.slice(1) : _t15;
            break;
          }
        default:
          return void n("abort", 400);
      }
      var r = 503;
      Ot(t + i).then(function (t) {
        var e = t.status;
        if (200 === e) return r = 501, t.json();
        setTimeout(function () {
          n(function (t) {
            return 404 === t;
          }(e) ? "abort" : "next", e);
        });
      }).then(function (t) {
        "object" == _typeof(t) && null !== t ? setTimeout(function () {
          n("success", t);
        }) : setTimeout(function () {
          404 === t ? n("abort", t) : n("next", r);
        });
      })["catch"](function () {
        n("next", r);
      });
    }
  };
  function Et(t, e) {
    switch (t) {
      case "local":
      case "session":
        ot[t] = e;
        break;
      case "all":
        for (var _t16 in ot) ot[_t16] = e;
    }
  }
  var Mt = "data-style";
  var Tt = "";
  function Ft(t) {
    Tt = t;
  }
  function Rt(t, e) {
    var n = Array.from(t.childNodes).find(function (t) {
      return t.hasAttribute && t.hasAttribute(Mt);
    });
    n || (n = document.createElement("style"), n.setAttribute(Mt, Mt), t.appendChild(n)), n.textContent = ":host{display:inline-block;vertical-align:" + (e ? "-0.125em" : "0") + "}span,svg{display:block}" + Tt;
  }
  var Lt = {
      "background-color": "currentColor"
    },
    Pt = {
      "background-color": "transparent"
    },
    Nt = {
      image: "var(--svg)",
      repeat: "no-repeat",
      size: "100% 100%"
    },
    zt = {
      "-webkit-mask": Lt,
      mask: Lt,
      background: Pt
    };
  for (var _t17 in zt) {
    var _e13 = zt[_t17];
    for (var _n11 in Nt) _e13[_t17 + "-" + _n11] = Nt[_n11];
  }
  function Qt(t) {
    return t ? t + (t.match(/^[-0-9.]+$/) ? "px" : "") : "inherit";
  }
  var qt;
  function Dt(t) {
    return void 0 === qt && function () {
      try {
        qt = window.trustedTypes.createPolicy("iconify", {
          createHTML: function createHTML(t) {
            return t;
          }
        });
      } catch (t) {
        qt = null;
      }
    }(), qt ? qt.createHTML(t) : t;
  }
  function Ut(t) {
    return Array.from(t.childNodes).find(function (t) {
      var e = t.tagName && t.tagName.toUpperCase();
      return "SPAN" === e || "SVG" === e;
    });
  }
  function Ht(t, e) {
    var i = e.icon.data,
      r = e.customisations,
      o = kt(i, r);
    r.preserveAspectRatio && (o.attributes.preserveAspectRatio = r.preserveAspectRatio);
    var s = e.renderedMode;
    var c;
    if ("svg" === s) c = function (t) {
      var e = document.createElement("span"),
        n = t.attributes;
      var i = "";
      n.width || (i = "width: inherit;"), n.height || (i += "height: inherit;"), i && (n.style = i);
      var r = jt(t.body, n);
      return e.innerHTML = Dt(r), e.firstChild;
    }(o);else c = function (t, e, n) {
      var i = document.createElement("span");
      var r = t.body;
      -1 !== r.indexOf("<a") && (r += "\x3c!-- " + Date.now() + " --\x3e");
      var o = t.attributes,
        s = At(jt(r, _objectSpread(_objectSpread({}, o), {}, {
          width: e.width + "",
          height: e.height + ""
        }))),
        c = i.style,
        a = _objectSpread({
          "--svg": s,
          width: Qt(o.width),
          height: Qt(o.height)
        }, n ? Lt : Pt);
      for (var _t18 in a) c.setProperty(_t18, a[_t18]);
      return i;
    }(o, _objectSpread(_objectSpread({}, n), i), "mask" === s);
    var a = Ut(t);
    a ? "SPAN" === c.tagName && a.tagName === c.tagName ? a.setAttribute("style", c.getAttribute("style")) : t.replaceChild(c, a) : t.appendChild(c);
  }
  function Jt(t, e, n) {
    return {
      rendered: !1,
      inline: e,
      icon: t,
      lastRender: n && (n.rendered ? n : n.lastRender)
    };
  }
  !function () {
    var t = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : "iconify-icon";
    var e, n;
    try {
      e = window.customElements, n = window.HTMLElement;
    } catch (t) {
      return;
    }
    if (!e || !n) return;
    var i = e.get(t);
    if (i) return i;
    var r = ["icon", "mode", "inline", "noobserver", "width", "height", "rotate", "flip"],
      o = /*#__PURE__*/function (_n12) {
        function o() {
          var _this;
          _classCallCheck(this, o);
          _this = _callSuper(this, o);
          _defineProperty(_this, "_shadowRoot", void 0);
          _defineProperty(_this, "_initialised", !1);
          _defineProperty(_this, "_state", void 0);
          _defineProperty(_this, "_checkQueued", !1);
          _defineProperty(_this, "_connected", !1);
          _defineProperty(_this, "_observer", null);
          _defineProperty(_this, "_visible", !0);
          var t = _this._shadowRoot = _this.attachShadow({
              mode: "open"
            }),
            e = _this.hasAttribute("inline");
          Rt(t, e), _this._state = Jt({
            value: ""
          }, e), _this._queueCheck();
          return _this;
        }
        _inherits(o, _n12);
        return _createClass(o, [{
          key: "connectedCallback",
          value: function connectedCallback() {
            this._connected = !0, this.startObserver();
          }
        }, {
          key: "disconnectedCallback",
          value: function disconnectedCallback() {
            this._connected = !1, this.stopObserver();
          }
        }, {
          key: "attributeChangedCallback",
          value: function attributeChangedCallback(t) {
            switch (t) {
              case "inline":
                {
                  var _t19 = this.hasAttribute("inline"),
                    _e14 = this._state;
                  _t19 !== _e14.inline && (_e14.inline = _t19, Rt(this._shadowRoot, _t19));
                  break;
                }
              case "noobserver":
                this.hasAttribute("noobserver") ? this.startObserver() : this.stopObserver();
                break;
              default:
                this._queueCheck();
            }
          }
        }, {
          key: "icon",
          get: function get() {
            var t = this.getAttribute("icon");
            if (t && "{" === t.slice(0, 1)) try {
              return JSON.parse(t);
            } catch (t) {}
            return t;
          },
          set: function set(t) {
            "object" == _typeof(t) && (t = JSON.stringify(t)), this.setAttribute("icon", t);
          }
        }, {
          key: "inline",
          get: function get() {
            return this.hasAttribute("inline");
          },
          set: function set(t) {
            t ? this.setAttribute("inline", "true") : this.removeAttribute("inline");
          }
        }, {
          key: "observer",
          get: function get() {
            return this.hasAttribute("observer");
          },
          set: function set(t) {
            t ? this.setAttribute("observer", "true") : this.removeAttribute("observer");
          }
        }, {
          key: "restartAnimation",
          value: function restartAnimation() {
            var t = this._state;
            if (t.rendered) {
              var _e15 = this._shadowRoot;
              if ("svg" === t.renderedMode) try {
                return void _e15.lastChild.setCurrentTime(0);
              } catch (t) {}
              Ht(_e15, t);
            }
          }
        }, {
          key: "status",
          get: function get() {
            var t = this._state;
            return t.rendered ? "rendered" : null === t.icon.data ? "failed" : "loading";
          }
        }, {
          key: "_queueCheck",
          value: function _queueCheck() {
            var _this2 = this;
            this._checkQueued || (this._checkQueued = !0, setTimeout(function () {
              _this2._check();
            }));
          }
        }, {
          key: "_check",
          value: function _check() {
            if (!this._checkQueued) return;
            this._checkQueued = !1;
            var t = this._state,
              e = this.getAttribute("icon");
            if (e !== t.icon.value) return void this._iconChanged(e);
            if (!t.rendered || !this._visible) return;
            var n = this.getAttribute("mode"),
              i = a(this);
            t.attrMode === n && !function (t, e) {
              for (var _n13 in c) if (t[_n13] !== e[_n13]) return !0;
              return !1;
            }(t.customisations, i) && Ut(this._shadowRoot) || this._renderIcon(t.icon, i, n);
          }
        }, {
          key: "_iconChanged",
          value: function _iconChanged(t) {
            var _this3 = this;
            var e = vt(t, function (t, e, n) {
              var i = _this3._state;
              if (i.rendered || _this3.getAttribute("icon") !== t) return;
              var r = {
                value: t,
                name: e,
                data: n
              };
              r.data ? _this3._gotIconData(r) : i.icon = r;
            });
            e.data ? this._gotIconData(e) : this._state = Jt(e, this._state.inline, this._state);
          }
        }, {
          key: "_forceRender",
          value: function _forceRender() {
            if (this._visible) this._queueCheck();else {
              var _t20 = Ut(this._shadowRoot);
              _t20 && this._shadowRoot.removeChild(_t20);
            }
          }
        }, {
          key: "_gotIconData",
          value: function _gotIconData(t) {
            this._checkQueued = !1, this._renderIcon(t, a(this), this.getAttribute("mode"));
          }
        }, {
          key: "_renderIcon",
          value: function _renderIcon(t, e, n) {
            var i = function (t, e) {
                switch (e) {
                  case "svg":
                  case "bg":
                  case "mask":
                    return e;
                }
                return "style" === e || !mt && -1 !== t.indexOf("<a") ? -1 === t.indexOf("currentColor") ? "bg" : "mask" : "svg";
              }(t.data.body, n),
              r = this._state.inline;
            Ht(this._shadowRoot, this._state = {
              rendered: !0,
              icon: t,
              inline: r,
              customisations: e,
              attrMode: n,
              renderedMode: i
            });
          }
        }, {
          key: "startObserver",
          value: function startObserver() {
            var _this4 = this;
            if (!this._observer && !this.hasAttribute("noobserver")) try {
              this._observer = new IntersectionObserver(function (t) {
                var e = t.some(function (t) {
                  return t.isIntersecting;
                });
                e !== _this4._visible && (_this4._visible = e, _this4._forceRender());
              }), this._observer.observe(this);
            } catch (t) {
              if (this._observer) {
                try {
                  this._observer.disconnect();
                } catch (t) {}
                this._observer = null;
              }
            }
          }
        }, {
          key: "stopObserver",
          value: function stopObserver() {
            this._observer && (this._observer.disconnect(), this._observer = null, this._visible = !0, this._connected && this._forceRender());
          }
        }], [{
          key: "observedAttributes",
          get: function get() {
            return r.slice(0);
          }
        }]);
      }(n);
    r.forEach(function (t) {
      t in o.prototype || Object.defineProperty(o.prototype, t, {
        get: function get() {
          return this.getAttribute(t);
        },
        set: function set(e) {
          null !== e ? this.setAttribute(t, e) : this.removeAttribute(t);
        }
      });
    });
    var s = function () {
      var t;
      T("", St), k(!0);
      try {
        t = window;
      } catch (t) {}
      if (t) {
        if (ft(), void 0 !== t.IconifyPreload) {
          var _e16 = t.IconifyPreload,
            _n14 = "Invalid IconifyPreload syntax.";
          "object" == _typeof(_e16) && null !== _e16 && (_e16 instanceof Array ? _e16 : [_e16]).forEach(function (t) {
            try {
              ("object" != _typeof(t) || null === t || t instanceof Array || "object" != _typeof(t.icons) || "string" != typeof t.prefix || !O(t)) && console.error(_n14);
            } catch (t) {
              console.error(_n14);
            }
          });
        }
        if (void 0 !== t.IconifyProviders) {
          var _e17 = t.IconifyProviders;
          if ("object" == _typeof(_e17) && null !== _e17) for (var _t21 in _e17) {
            var _n15 = "IconifyProviders[" + _t21 + "] is invalid.";
            try {
              var _i2 = _e17[_t21];
              if ("object" != _typeof(_i2) || !_i2 || void 0 === _i2.resources) continue;
              D(_t21, _i2) || console.error(_n15);
            } catch (t) {
              console.error(_n15);
            }
          }
        }
      }
      return {
        enableCache: function enableCache(t) {
          return Et(t, !0);
        },
        disableCache: function disableCache(t) {
          return Et(t, !1);
        },
        iconLoaded: C,
        iconExists: C,
        getIcon: I,
        listIcons: w,
        addIcon: A,
        addCollection: O,
        calculateSize: wt,
        buildIcon: kt,
        iconToHTML: jt,
        svgToURL: At,
        loadIcons: gt,
        loadIcon: bt,
        addAPIProvider: D,
        appendCustomStyle: Ft,
        _api: {
          getAPIConfig: U,
          setAPIModule: T,
          sendAPIQuery: B,
          setFetch: Ct,
          getFetch: It,
          listAPIProviders: H
        }
      };
    }();
    for (var _t22 in s) o[_t22] = o.prototype[_t22] = s[_t22];
    e.define(t, o);
  }();
}();