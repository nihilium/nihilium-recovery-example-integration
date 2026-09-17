/* @ds-bundle: {"namespace":"NihiliumDS","components":[{"name":"Button","sourcePath":"components/general/Button/Button.jsx"},{"name":"Card","sourcePath":"components/general/Card/Card.jsx"},{"name":"CardGrid","sourcePath":"components/general/CardGrid/CardGrid.jsx"},{"name":"Checkbox","sourcePath":"components/general/Checkbox/Checkbox.jsx"},{"name":"FeatureCard","sourcePath":"components/general/FeatureCard/FeatureCard.jsx"},{"name":"Heading","sourcePath":"components/general/Heading/Heading.jsx"},{"name":"Hero","sourcePath":"components/general/Hero/Hero.jsx"},{"name":"Page","sourcePath":"components/general/Page/Page.jsx"},{"name":"Section","sourcePath":"components/general/Section/Section.jsx"},{"name":"StatusMessage","sourcePath":"components/general/StatusMessage/StatusMessage.jsx"},{"name":"SubscribeForm","sourcePath":"components/general/SubscribeForm/SubscribeForm.jsx"},{"name":"TextInput","sourcePath":"components/general/TextInput/TextInput.jsx"},{"name":"TextLink","sourcePath":"components/general/TextLink/TextLink.jsx"},{"name":"TopBar","sourcePath":"components/general/TopBar/TopBar.jsx"}],"sourceHashes":{"components/general/Button/Button.jsx":"8f04ac218b30","components/general/Button/Button.d.ts":"821e8c2591d2","components/general/Button/Button.prompt.md":"0f07174f1241","components/general/Card/Card.jsx":"2ca577e16c3d","components/general/Card/Card.d.ts":"34264787f874","components/general/Card/Card.prompt.md":"1e2ef2719e7e","components/general/CardGrid/CardGrid.jsx":"5aebd6dbe097","components/general/CardGrid/CardGrid.d.ts":"d9c3cdb28d3c","components/general/CardGrid/CardGrid.prompt.md":"dc362fc5de18","components/general/Checkbox/Checkbox.jsx":"988009d70c8a","components/general/Checkbox/Checkbox.d.ts":"d27fff4e392b","components/general/Checkbox/Checkbox.prompt.md":"bed340c43a40","components/general/FeatureCard/FeatureCard.jsx":"b19b76d61638","components/general/FeatureCard/FeatureCard.d.ts":"b1c1860ab305","components/general/FeatureCard/FeatureCard.prompt.md":"38f59b7a9438","components/general/Heading/Heading.jsx":"5e78a009a8ac","components/general/Heading/Heading.d.ts":"7b8ed3db88a6","components/general/Heading/Heading.prompt.md":"0e358fe7b85b","components/general/Hero/Hero.jsx":"d828efd533d7","components/general/Hero/Hero.d.ts":"5e1bd7b4ded5","components/general/Hero/Hero.prompt.md":"3eaaabaee1b8","components/general/Page/Page.jsx":"b50ce2deda21","components/general/Page/Page.d.ts":"375843979a13","components/general/Page/Page.prompt.md":"a43a09fe45b6","components/general/Section/Section.jsx":"eb99101352e1","components/general/Section/Section.d.ts":"7099216f4714","components/general/Section/Section.prompt.md":"adc21d0b73bf","components/general/StatusMessage/StatusMessage.jsx":"270d113d88d8","components/general/StatusMessage/StatusMessage.d.ts":"a3d1088b719d","components/general/StatusMessage/StatusMessage.prompt.md":"71fe26a93b85","components/general/SubscribeForm/SubscribeForm.jsx":"85d35a5a6e31","components/general/SubscribeForm/SubscribeForm.d.ts":"8db18d6146b8","components/general/SubscribeForm/SubscribeForm.prompt.md":"2ef21f242eef","components/general/TextInput/TextInput.jsx":"2361158c6373","components/general/TextInput/TextInput.d.ts":"755eb331717d","components/general/TextInput/TextInput.prompt.md":"0f78bbcdf251","components/general/TextLink/TextLink.jsx":"e9e421c4d9d6","components/general/TextLink/TextLink.d.ts":"57ab5fc6ff63","components/general/TextLink/TextLink.prompt.md":"183f65fc9b37","components/general/TopBar/TopBar.jsx":"6679cd80f02f","components/general/TopBar/TopBar.d.ts":"7ede13d3e1b3","components/general/TopBar/TopBar.prompt.md":"4f7fa387010d"},"inlinedExternals":[],"builtBy":"cc-design-sync"} */
"use strict";
var NihiliumDS = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // <define:import.meta.env>
  var init_define_import_meta_env = __esm({
    "<define:import.meta.env>"() {
    }
  });

  // shim:react-shim
  var require_react_shim = __commonJS({
    "shim:react-shim"(exports, module) {
      init_define_import_meta_env();
      var R = window.React;
      function np(p, k) {
        var o = {};
        for (var x in p) if (x !== "children") o[x] = p[x];
        if (k !== void 0) o.key = k;
        return o;
      }
      function jsx(t, p, k) {
        var c = p && p.children;
        return c === void 0 ? R.createElement(t, np(p, k)) : R.createElement(t, np(p, k), c);
      }
      function jsxs(t, p, k) {
        return R.createElement.apply(R, [t, np(p, k)].concat(p.children));
      }
      module.exports = R;
      module.exports.jsx = jsx;
      module.exports.jsxs = jsxs;
      module.exports.jsxDEV = function(t, p, k, s) {
        return (s ? jsxs : jsx)(t, p, k);
      };
      module.exports.Fragment = R.Fragment;
    }
  });

  // packages/nihilium-ds/dist/index.mjs
  var index_exports = {};
  __export(index_exports, {
    Button: () => Button,
    Card: () => Card,
    CardGrid: () => CardGrid,
    Checkbox: () => Checkbox,
    ClockIcon: () => ClockIcon_default,
    DocumentCheckIcon: () => DocumentCheckIcon_default,
    FeatureCard: () => FeatureCard,
    Heading: () => Heading,
    Hero: () => Hero,
    KeyIcon: () => KeyIcon_default,
    LockClosedIcon: () => LockClosedIcon_default,
    Page: () => Page,
    Section: () => Section,
    ShieldCheckIcon: () => ShieldCheckIcon_default,
    StatusMessage: () => StatusMessage,
    SubscribeForm: () => SubscribeForm,
    TextInput: () => TextInput,
    TextLink: () => TextLink,
    TopBar: () => TopBar,
    UserGroupIcon: () => UserGroupIcon_default
  });
  init_define_import_meta_env();
  var import_react = __toESM(require_react_shim(), 1);
  var import_react2 = __toESM(require_react_shim(), 1);
  var import_react3 = __toESM(require_react_shim(), 1);
  var import_react4 = __toESM(require_react_shim(), 1);
  var import_react5 = __toESM(require_react_shim(), 1);
  var import_react6 = __toESM(require_react_shim(), 1);
  var import_react7 = __toESM(require_react_shim(), 1);
  var import_react8 = __toESM(require_react_shim(), 1);
  var import_react9 = __toESM(require_react_shim(), 1);
  var import_react10 = __toESM(require_react_shim(), 1);
  var import_react11 = __toESM(require_react_shim(), 1);
  var import_react12 = __toESM(require_react_shim(), 1);
  var import_react13 = __toESM(require_react_shim(), 1);
  var import_react14 = __toESM(require_react_shim(), 1);
  var React15 = __toESM(require_react_shim(), 1);
  var React16 = __toESM(require_react_shim(), 1);
  var React17 = __toESM(require_react_shim(), 1);
  var React18 = __toESM(require_react_shim(), 1);
  var React19 = __toESM(require_react_shim(), 1);
  var React20 = __toESM(require_react_shim(), 1);
  function cx(...parts) {
    return parts.filter(Boolean).join(" ");
  }
  function Page({ children, snap = true, className }) {
    return /* @__PURE__ */ import_react.default.createElement("div", { className: cx("nih-page", snap && "nih-page--snap", className) }, children);
  }
  function Section({ children, id, width = "lg", className }) {
    return /* @__PURE__ */ import_react2.default.createElement("section", { id, className: cx("nih-section", `nih-section--${width}`, className) }, /* @__PURE__ */ import_react2.default.createElement("div", { className: "nih-section__inner" }, children));
  }
  function Heading({ children, level = 2, align = "left", className }) {
    const Tag = ["h1", "h2", "h3", "h4"][level - 1];
    return /* @__PURE__ */ import_react4.default.createElement(
      Tag,
      {
        className: cx(
          "nih-heading",
          `nih-heading--${level}`,
          align === "center" && "nih-heading--center",
          className
        )
      },
      children
    );
  }
  function Hero({ title, tagline, description, logo, id, className }) {
    return /* @__PURE__ */ import_react3.default.createElement("section", { id, className: cx("nih-hero", className) }, logo ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "nih-hero__logo" }, logo) : null, /* @__PURE__ */ import_react3.default.createElement(Heading, { level: 1, align: "center" }, title), tagline ? /* @__PURE__ */ import_react3.default.createElement("p", { className: "nih-hero__tagline" }, tagline) : null, description ? /* @__PURE__ */ import_react3.default.createElement("p", { className: "nih-hero__description" }, description) : null);
  }
  function TopBar({
    brand = "NIHILIUM",
    logo,
    links = [],
    onBrandClick,
    position = "fixed",
    className
  }) {
    const [tipFor, setTipFor] = import_react5.default.useState(null);
    return /* @__PURE__ */ import_react5.default.createElement(
      "div",
      {
        className: cx("nih-topbar", position === "fixed" && "nih-topbar--fixed", className)
      },
      /* @__PURE__ */ import_react5.default.createElement("div", { className: "nih-topbar__inner" }, /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "nih-topbar__brand", onClick: onBrandClick }, logo ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "nih-topbar__logo" }, logo) : null, /* @__PURE__ */ import_react5.default.createElement("span", null, brand)), /* @__PURE__ */ import_react5.default.createElement("nav", { className: "nih-topbar__nav" }, links.map((link, i) => {
        const cls = cx("nih-topbar__link", Boolean(link.icon) && "nih-topbar__link--icon");
        const body = link.icon ?? link.label;
        const node = link.href ? /* @__PURE__ */ import_react5.default.createElement(
          "a",
          {
            href: link.href,
            className: cls,
            "aria-label": link.icon ? link.label : void 0,
            ...link.external ? { target: "_blank", rel: "noopener noreferrer" } : null
          },
          body
        ) : /* @__PURE__ */ import_react5.default.createElement(
          "button",
          {
            type: "button",
            className: cls,
            onClick: link.onClick,
            "aria-label": link.icon ? link.label : void 0
          },
          body
        );
        if (!link.tooltip) return /* @__PURE__ */ import_react5.default.createElement(import_react5.default.Fragment, { key: i }, node);
        return /* @__PURE__ */ import_react5.default.createElement(
          "span",
          {
            key: i,
            className: "nih-topbar__tip-wrap",
            onMouseEnter: () => setTipFor(i),
            onMouseLeave: () => setTipFor(null)
          },
          node,
          tipFor === i ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "nih-topbar__tip" }, link.tooltip) : null
        );
      })))
    );
  }
  function Card({ children, padding = "md", interactive = false, className }) {
    return /* @__PURE__ */ import_react6.default.createElement(
      "div",
      {
        className: cx(
          "nih-card",
          `nih-card--${padding}`,
          interactive && "nih-card--interactive",
          className
        )
      },
      children
    );
  }
  function FeatureCard({
    title,
    children,
    icon,
    interactive = true,
    className
  }) {
    return /* @__PURE__ */ import_react7.default.createElement(Card, { padding: "md", interactive, className }, icon ? /* @__PURE__ */ import_react7.default.createElement("span", { className: "nih-feature__icon" }, icon) : null, /* @__PURE__ */ import_react7.default.createElement(Heading, { level: 3 }, title), children ? /* @__PURE__ */ import_react7.default.createElement("p", { className: cx("nih-feature__body") }, children) : null);
  }
  function CardGrid({ children, columns = 3, gap = "md", className }) {
    return /* @__PURE__ */ import_react8.default.createElement(
      "div",
      {
        className: cx(
          "nih-grid",
          `nih-grid--${columns}`,
          gap === "lg" && "nih-grid--gap-lg",
          className
        )
      },
      children
    );
  }
  function TextLink({
    href,
    children,
    external = false,
    underline = true,
    className
  }) {
    return /* @__PURE__ */ import_react9.default.createElement(
      "a",
      {
        href,
        className: cx("nih-link", underline && "nih-link--underline", className),
        ...external ? { target: "_blank", rel: "noopener noreferrer" } : null
      },
      children
    );
  }
  function Button({
    children,
    variant = "solid",
    fullWidth = false,
    type = "button",
    disabled = false,
    onClick,
    className
  }) {
    return /* @__PURE__ */ import_react10.default.createElement(
      "button",
      {
        type,
        disabled,
        onClick,
        className: cx(
          "nih-button",
          `nih-button--${variant}`,
          fullWidth && "nih-button--block",
          className
        )
      },
      children
    );
  }
  function TextInput({
    type = "text",
    value,
    defaultValue,
    onChange,
    placeholder,
    required = false,
    disabled = false,
    id,
    name,
    ariaLabel,
    className
  }) {
    return /* @__PURE__ */ import_react11.default.createElement(
      "input",
      {
        type,
        value,
        defaultValue,
        onChange,
        placeholder,
        required,
        disabled,
        id,
        name,
        "aria-label": ariaLabel,
        className: cx("nih-input", className)
      }
    );
  }
  function Checkbox({
    label,
    id,
    checked,
    defaultChecked,
    onChange,
    disabled = false,
    name,
    className
  }) {
    const inputId = id ?? import_react12.default.useId();
    return /* @__PURE__ */ import_react12.default.createElement("div", { className: cx("nih-checkbox", className) }, /* @__PURE__ */ import_react12.default.createElement(
      "input",
      {
        type: "checkbox",
        id: inputId,
        name,
        checked,
        defaultChecked,
        onChange,
        disabled,
        className: "nih-checkbox__control"
      }
    ), /* @__PURE__ */ import_react12.default.createElement("label", { htmlFor: inputId, className: "nih-checkbox__label" }, label));
  }
  function StatusMessage({ tone, children, className }) {
    return /* @__PURE__ */ import_react13.default.createElement("p", { role: "status", className: cx("nih-status", `nih-status--${tone}`, className) }, children);
  }
  function SubscribeForm({
    title = "Stay Updated",
    placeholder = "Enter your email",
    submitLabel = "Subscribe to Updates",
    submittingLabel = "Subscribing...",
    consentLabel = "Contact me about Nihilium",
    status = null,
    submitting = false,
    onSubmit,
    className
  }) {
    const [email, setEmail] = import_react14.default.useState("");
    const [consent, setConsent] = import_react14.default.useState(false);
    return /* @__PURE__ */ import_react14.default.createElement(Card, { padding: "lg", className }, /* @__PURE__ */ import_react14.default.createElement(Heading, { level: 3 }, title), /* @__PURE__ */ import_react14.default.createElement(
      "form",
      {
        className: cx("nih-subscribe__fields"),
        onSubmit: (e) => {
          e.preventDefault();
          onSubmit?.({ email, consent });
        }
      },
      /* @__PURE__ */ import_react14.default.createElement(
        TextInput,
        {
          type: "email",
          value: email,
          onChange: (e) => setEmail(e.target.value),
          placeholder,
          required: true,
          ariaLabel: "Email address"
        }
      ),
      /* @__PURE__ */ import_react14.default.createElement(
        Checkbox,
        {
          label: consentLabel,
          checked: consent,
          onChange: (e) => setConsent(e.target.checked)
        }
      ),
      /* @__PURE__ */ import_react14.default.createElement(Button, { type: "submit", variant: "solid", fullWidth: true, disabled: submitting }, submitting ? submittingLabel : submitLabel),
      status ? /* @__PURE__ */ import_react14.default.createElement(StatusMessage, { tone: status.tone }, status.message) : null
    ));
  }
  function ClockIcon({
    title,
    titleId,
    ...props
  }, svgRef) {
    return /* @__PURE__ */ React15.createElement("svg", Object.assign({
      xmlns: "http://www.w3.org/2000/svg",
      fill: "none",
      viewBox: "0 0 24 24",
      strokeWidth: 1.5,
      stroke: "currentColor",
      "aria-hidden": "true",
      "data-slot": "icon",
      ref: svgRef,
      "aria-labelledby": titleId
    }, props), title ? /* @__PURE__ */ React15.createElement("title", {
      id: titleId
    }, title) : null, /* @__PURE__ */ React15.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
    }));
  }
  var ForwardRef = /* @__PURE__ */ React15.forwardRef(ClockIcon);
  var ClockIcon_default = ForwardRef;
  function DocumentCheckIcon({
    title,
    titleId,
    ...props
  }, svgRef) {
    return /* @__PURE__ */ React16.createElement("svg", Object.assign({
      xmlns: "http://www.w3.org/2000/svg",
      fill: "none",
      viewBox: "0 0 24 24",
      strokeWidth: 1.5,
      stroke: "currentColor",
      "aria-hidden": "true",
      "data-slot": "icon",
      ref: svgRef,
      "aria-labelledby": titleId
    }, props), title ? /* @__PURE__ */ React16.createElement("title", {
      id: titleId
    }, title) : null, /* @__PURE__ */ React16.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M10.125 2.25h-4.5c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125v-9M10.125 2.25h.375a9 9 0 0 1 9 9v.375M10.125 2.25A3.375 3.375 0 0 1 13.5 5.625v1.5c0 .621.504 1.125 1.125 1.125h1.5a3.375 3.375 0 0 1 3.375 3.375M9 15l2.25 2.25L15 12"
    }));
  }
  var ForwardRef2 = /* @__PURE__ */ React16.forwardRef(DocumentCheckIcon);
  var DocumentCheckIcon_default = ForwardRef2;
  function KeyIcon({
    title,
    titleId,
    ...props
  }, svgRef) {
    return /* @__PURE__ */ React17.createElement("svg", Object.assign({
      xmlns: "http://www.w3.org/2000/svg",
      fill: "none",
      viewBox: "0 0 24 24",
      strokeWidth: 1.5,
      stroke: "currentColor",
      "aria-hidden": "true",
      "data-slot": "icon",
      ref: svgRef,
      "aria-labelledby": titleId
    }, props), title ? /* @__PURE__ */ React17.createElement("title", {
      id: titleId
    }, title) : null, /* @__PURE__ */ React17.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
    }));
  }
  var ForwardRef3 = /* @__PURE__ */ React17.forwardRef(KeyIcon);
  var KeyIcon_default = ForwardRef3;
  function LockClosedIcon({
    title,
    titleId,
    ...props
  }, svgRef) {
    return /* @__PURE__ */ React18.createElement("svg", Object.assign({
      xmlns: "http://www.w3.org/2000/svg",
      fill: "none",
      viewBox: "0 0 24 24",
      strokeWidth: 1.5,
      stroke: "currentColor",
      "aria-hidden": "true",
      "data-slot": "icon",
      ref: svgRef,
      "aria-labelledby": titleId
    }, props), title ? /* @__PURE__ */ React18.createElement("title", {
      id: titleId
    }, title) : null, /* @__PURE__ */ React18.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
    }));
  }
  var ForwardRef4 = /* @__PURE__ */ React18.forwardRef(LockClosedIcon);
  var LockClosedIcon_default = ForwardRef4;
  function ShieldCheckIcon({
    title,
    titleId,
    ...props
  }, svgRef) {
    return /* @__PURE__ */ React19.createElement("svg", Object.assign({
      xmlns: "http://www.w3.org/2000/svg",
      fill: "none",
      viewBox: "0 0 24 24",
      strokeWidth: 1.5,
      stroke: "currentColor",
      "aria-hidden": "true",
      "data-slot": "icon",
      ref: svgRef,
      "aria-labelledby": titleId
    }, props), title ? /* @__PURE__ */ React19.createElement("title", {
      id: titleId
    }, title) : null, /* @__PURE__ */ React19.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
    }));
  }
  var ForwardRef5 = /* @__PURE__ */ React19.forwardRef(ShieldCheckIcon);
  var ShieldCheckIcon_default = ForwardRef5;
  function UserGroupIcon({
    title,
    titleId,
    ...props
  }, svgRef) {
    return /* @__PURE__ */ React20.createElement("svg", Object.assign({
      xmlns: "http://www.w3.org/2000/svg",
      fill: "none",
      viewBox: "0 0 24 24",
      strokeWidth: 1.5,
      stroke: "currentColor",
      "aria-hidden": "true",
      "data-slot": "icon",
      ref: svgRef,
      "aria-labelledby": titleId
    }, props), title ? /* @__PURE__ */ React20.createElement("title", {
      id: titleId
    }, title) : null, /* @__PURE__ */ React20.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"
    }));
  }
  var ForwardRef6 = /* @__PURE__ */ React20.forwardRef(UserGroupIcon);
  var UserGroupIcon_default = ForwardRef6;
  return __toCommonJS(index_exports);
})();
window.NihiliumDS=NihiliumDS.__dsMainNs?Object.assign({},NihiliumDS,NihiliumDS.__dsMainNs,{__dsMainNs:undefined}):NihiliumDS;
