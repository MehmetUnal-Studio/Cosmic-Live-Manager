/**
 * Max/MSP OSCQuery Server
 * A node.script-based external object for creating OSCQuery servers
 *
 * Usage in Max:
 *   [node.script oscquery.server.js]
 *   |
 *   [route state osc_message error host_info]
 *   |
 *   [state( [outlet 0]  // Server state (started/stopped)
 *   [osc_message( [outlet 1]  // Incoming OSC messages
 *   [error( [outlet 2]  // Error messages
 *   [host_info( [outlet 3]  // Host info
 *
 * Messages (send to inlet):
 *   start                    - Start the OSCQuery server
 *   stop                     - Stop the OSCQuery server
 *   add_method path [args]   - Add an OSC method at path
 *                              Format: path [description] [access] [arg_type1 [range1]] [arg_type2 [range2]] ...
 *                              access: READONLY|WRITEONLY|READWRITE|RO|WO|RW
 *                              arg_type: I|INT|F|FLOAT|S|STRING|B|BOOL|T|TRUE|FALSE|N|NULL|IMPULSE|BANG
 *                              range: min max OR vals val1 val2 ...
 *   remove_method path       - Remove an OSC method at path
 *   set_value path [index] value - Set value for method at path, argument index (default: 0)
 *   send_value path ...args  - Set and broadcast value to WebSocket clients
 *   unset_value path [index] - Unset value for method at path, argument index (default: 0)
 *   get_host_info            - Get host info (outputs to host_info outlet)
 *   is_started               - Check if server is started (outputs to state outlet)
 *   load_from_json path|json - Load Max objects from JSON file path or JSON string/object
 *                              Creates OSC methods for each object in the JSON
 *                              Format matches maxobjects.json structure
 *   logging enabled|disabled - Enable or disable logging (default: enabled)
 *   log_tag tag              - Set log tag prefix (default: "[OSCQuery Server]")
 *                              Use empty string to clear tag
 *   incoming_messages enabled|disabled - Enable or disable forwarding incoming OSC messages
 *                                        to Max outlet (default: enabled)
 *
 * Arguments (command-line or Max object attributes):
 *   http_port=<number>       - HTTP server port (default: random free port)
 *   bind_address=<string>   - Address to bind server to (default: all interfaces)
 *   service_name=<string>    - mDNS service name (default: "MaxOSCQuery")
 *   osc_port=<number>        - OSC port (default: same as http_port)
 *   ws_port=<number>         - WebSocket port (default: same as http_port)
 *   autostart=<true|false>   - Automatically start server on initialization (default: true)
 *   broadcast=<true|false>   - Broadcast OSC messages to all clients (default: true)
 *   description=<string>     - Root description for OSCQuery server (default: undefined)
 *   osc_query_host_name=<string> - OSCQuery host name (default: service_name)
 *
 * Note: node.script has only 1 output edge. Data is sent with routing tags:
 *   - "state" for server state (outlet 0)
 *   - "osc_message" for incoming OSC messages (outlet 1)
 *   - "error" for errors (outlet 2)
 *   - "host_info" for host info (outlet 3)
 *
 * Inlets: 1 (all messages)
 * Outlets: 1 (with routing tags - use [route] to split)
 */

const maxAPI = require("max-api");
const fs = require("fs");
const path = require("path");
const { OSCQueryServer, OSCTypeSimple, OSCQAccess } = require("oscquery");

/**
 * Send data to Max outlet with routing tag
 * node.script has only 1 output edge
 * We send data with routing tags so Max can route to different destinations
 * Format: [tag, ...data] where tag identifies the outlet type
 */
function outletTo(index, ...args) {
  let tag;
  switch (index) {
    case 0:
      tag = "state"; // Server state
      break;
    case 1:
      tag = "osc_message"; // Incoming OSC messages
      break;
    case 2:
      tag = "error"; // Errors
      break;
    case 3:
      tag = "host_info"; // Host info
      break;
    case 5:
      tag = "logs"; // Logs parameter
      break;
    default:
      tag = "unknown";
  }
  // Send with routing tag as first argument
  maxAPI.outlet(tag, ...args);
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  logger({ args: args });

  const httpPortArg = args.find((arg) => arg.startsWith("http_port="));
  const httpPort = httpPortArg ? parseInt(httpPortArg.split("=")[1], 10) : null;

  const bindAddressArg = args.find((arg) => arg.startsWith("bind_address="));
  const bindAddress = bindAddressArg ? bindAddressArg.split("=")[1] : undefined;

  const serviceNameArg = args.find((arg) => arg.startsWith("service_name="));
  const serviceName = serviceNameArg
    ? serviceNameArg.split("=")[1]
    : "MaxOSCQuery";

  const oscPortArg = args.find((arg) => arg.startsWith("osc_port="));
  const oscPort = oscPortArg ? parseInt(oscPortArg.split("=")[1], 10) : null;

  const wsPortArg = args.find((arg) => arg.startsWith("ws_port="));
  const wsPort = wsPortArg ? parseInt(wsPortArg.split("=")[1], 10) : null;

  const autostartArg = args.find((arg) => arg.startsWith("autostart="));
  const autostart = autostartArg
    ? autostartArg.split("=")[1] === "true" ||
    autostartArg.split("=")[1] === "1"
    : true; // Default to true

  const broadcastArg = args.find((arg) => arg.startsWith("broadcast="));
  const broadcast = broadcastArg
    ? broadcastArg.split("=")[1] === "true" ||
    broadcastArg.split("=")[1] === "1"
    : true; // Default to true

  const descriptionArg = args.find((arg) => arg.startsWith("description="));
  const rootDescription = descriptionArg
    ? descriptionArg.split("=")[1]
    : serviceName;

  const oscQueryHostNameArg = args.find((arg) =>
    arg.startsWith("osc_query_host_name=")
  );
  const oscQueryHostName = oscQueryHostNameArg
    ? oscQueryHostNameArg.split("=")[1]
    : serviceName;

  return {
    httpPort,
    bindAddress,
    serviceName,
    oscPort,
    wsPort,
    autostart,
    broadcast,
    rootDescription,
    oscQueryHostName,
  };
}

// Initialize state object
const state = {
  server: null,
  started: false,
  hostInfo: null,
  options: {},
  logging: {
    enabled: true,
    tag: "[OSCQuery Server]",
  },
  incomingMessages: {
    enabled: true,
  },
  // Track WebSocket client roots so we can remove OSCQuery nodes on disconnect
  clientRoots: {},
};

// Parse command line arguments
const args = parseArgs();
state.options = {
  httpPort: args.httpPort,
  bindAddress: args.bindAddress,
  serviceName: args.serviceName,
  oscPort: args.oscPort,
  wsPort: args.wsPort,
  autostart: args.autostart,
  broadcast: args.broadcast,
  rootDescription: args.rootDescription,
  oscQueryHostName: args.oscQueryHostName,
};

/**
 * Logger function that wraps maxAPI.post
 * Can be enabled/disabled and includes optional tag prefix
 */
function logger(...args) {
  if (!state.logging.enabled) {
    return;
  }

  if (state.logging.tag) {
    const message = state.logging.tag + " " + args.join(" ");
    outletTo(5, message);
  }
}

logger("node version: ", process.version);
logger(
  "OSCQuery Server initialized with options:",
  JSON.stringify(state.options, null, 2)
);

/**
 * Convert Max message arguments to OSC type
 */
function parseOSCType(typeStr) {
  if (!typeStr || typeof typeStr !== "string") {
    return OSCTypeSimple.FLOAT; // Default
  }

  const type = typeStr.toUpperCase();
  switch (type) {
    case "I":
    case "INT":
    case "INTEGER":
      return OSCTypeSimple.INT;
    case "F":
    case "FLOAT":
      return OSCTypeSimple.FLOAT;
    case "S":
    case "STRING":
      return OSCTypeSimple.STRING;
    case "B":
    case "BOOL":
    case "BOOLEAN":
      return OSCTypeSimple.BOOL;
    case "T":
    case "TRUE":
      return OSCTypeSimple.TRUE;
    case "FALSE":
      return OSCTypeSimple.FALSE;
    case "N":
    case "NULL":
      return OSCTypeSimple.NIL;
    case "IMPULSE":
    case "BANG":
      return OSCTypeSimple.TRUE;
    default:
      return OSCTypeSimple.FLOAT;
  }
}

/**
 * Parse access string to OSCQAccess enum
 */
function parseAccess(accessStr) {
  if (!accessStr || typeof accessStr !== "string") {
    return OSCQAccess.READWRITE; // Default
  }

  const access = accessStr.toUpperCase();
  switch (access) {
    case "READONLY":
    case "READ_ONLY":
    case "RO":
      return OSCQAccess.READONLY;
    case "WRITEONLY":
    case "WRITE_ONLY":
    case "WO":
      return OSCQAccess.WRITEONLY;
    case "READWRITE":
    case "READ_WRITE":
    case "RW":
      return OSCQAccess.READWRITE;
    default:
      return OSCQAccess.READWRITE;
  }
}

/**
 * Parse range from arguments
 * Format: min max or vals val1 val2 val3 ...
 */
function parseRange(args, startIndex) {
  if (args.length <= startIndex) {
    return undefined;
  }

  const first = args[startIndex];
  if (first === "vals" || first === "values") {
    // Value list: vals val1 val2 val3 ...
    const values = args.slice(startIndex + 1);
    return { vals: values };
  } else if (typeof first === "number") {
    // Min/max range: min max
    const min = first;
    const max = args.length > startIndex + 1 ? args[startIndex + 1] : undefined;
    return { min, max };
  }

  return undefined;
}

/**
 * Map Max/MSP type to OSC type
 */
function mapMaxTypeToOSCType(maxType) {
  if (!maxType || typeof maxType !== "string") {
    return OSCTypeSimple.FLOAT; // Default
  }

  switch (maxType.toLowerCase()) {
    case "float":
      return OSCTypeSimple.FLOAT;
    case "bool":
    case "boolean":
      return OSCTypeSimple.INT; // Booleans in Max are 0/1, use INT
    case "enum":
      return OSCTypeSimple.INT; // Enums are typically represented as integers
    case "string":
    case "text":
      return OSCTypeSimple.STRING;
    case "bang":
    case "impulse":
      return OSCTypeSimple.TRUE; // Bang/impulse can use TRUE as trigger
    default:
      return OSCTypeSimple.FLOAT; // Default fallback
  }
}

/**
 * Convert Max range format to OSCQuery range format
 * Handles MIN/MAX (numeric range) and VALS (menu/enum labels, TouchDesigner-style)
 */
function convertMaxRange(maxRange, min, max, parameterRange) {
  // Highest priority: parameter_range from live.menu (list of labels)
  if (Array.isArray(parameterRange) && parameterRange.length > 0) {
    return { vals: parameterRange };
  }

  // Menu/enum: range.VALS (list of allowed labels)
  if (maxRange && maxRange.VALS && Array.isArray(maxRange.VALS)) {
    return { vals: maxRange.VALS };
  }

  // Prefer explicit min/max if available
  if (min !== undefined && max !== undefined) {
    return { min, max };
  }

  // Fall back to range.MIN/MAX
  if (maxRange && maxRange.MIN !== undefined && maxRange.MAX !== undefined) {
    return { min: maxRange.MIN, max: maxRange.MAX };
  }

  return undefined;
}

/**
 * Parse OSC type string to OSCTypeSimple or array of types
 * Handles strings like "f", "i", "ff", "fff", "s", "r", "N", etc.
 */
function parseOSCTypeString(typeStr) {
  if (!typeStr || typeof typeStr !== "string") {
    return OSCTypeSimple.FLOAT;
  }

  // Map single character OSC types
  const typeMap = {
    i: OSCTypeSimple.INT,
    f: OSCTypeSimple.FLOAT,
    s: OSCTypeSimple.STRING,
    b: OSCTypeSimple.BLOB,
    h: OSCTypeSimple.BIGINT,
    t: OSCTypeSimple.TIMETAG,
    d: OSCTypeSimple.DOUBLE,
    S: OSCTypeSimple.ALTSTRING,
    c: OSCTypeSimple.CHAR,
    r: OSCTypeSimple.COLOR,
    m: OSCTypeSimple.MIDI,
    T: OSCTypeSimple.TRUE,
    F: OSCTypeSimple.FALSE,
    N: OSCTypeSimple.NIL,
    I: OSCTypeSimple.INFINITUM,
  };

  // If single character, return mapped type
  if (typeStr.length === 1) {
    return typeMap[typeStr] || OSCTypeSimple.FLOAT;
  }

  // If multiple characters, return array of types
  return typeStr.split("").map((char) => typeMap[char] || OSCTypeSimple.FLOAT);
}

/**
 * Parse ACCESS number to OSCQAccess enum
 */
function parseOSCQueryAccess(access) {
  if (typeof access === "number") {
    switch (access) {
      case 0:
        return OSCQAccess.NO_VALUE;
      case 1:
        return OSCQAccess.READONLY;
      case 2:
        return OSCQAccess.WRITEONLY;
      case 3:
        return OSCQAccess.READWRITE;
      default:
        return OSCQAccess.READWRITE;
    }
  }
  return OSCQAccess.READWRITE;
}

/**
 * Convert OSCQuery RANGE array to OSCQuery range format
 */
function convertOSCQueryRange(rangeArray) {
  if (!Array.isArray(rangeArray) || rangeArray.length === 0) {
    return undefined;
  }

  // If single range, return it directly
  if (rangeArray.length === 1) {
    const range = rangeArray[0];
    if (range.VALS) {
      return { vals: range.VALS };
    }
    if (range.MIN !== undefined && range.MAX !== undefined) {
      return { min: range.MIN, max: range.MAX };
    }
    return undefined;
  }

  // Multiple ranges - return array
  return rangeArray.map((range) => {
    if (range.VALS) {
      return { vals: range.VALS };
    }
    if (range.MIN !== undefined && range.MAX !== undefined) {
      return { min: range.MIN, max: range.MAX };
    }
    return null;
  });
}

/**
 * Recursively extract OSCQuery nodes from nested CONTENTS structure
 * An OSCQuery node is identified by having a "FULL_PATH" and "TYPE" property
 */
function extractOSCQueryNodes(obj, collected = [], parentKey = "") {
  if (!obj || typeof obj !== "object") {
    return collected;
  }

  // Check if this is an OSCQuery node (has FULL_PATH and TYPE)
  if (obj.FULL_PATH && obj.TYPE) {
    collected.push({
      key: parentKey || obj.FULL_PATH,
      node: obj,
    });
    // Don't recurse into CONTENTS if this is a leaf node
    if (!obj.CONTENTS) {
      return collected;
    }
  }

  // If it's an array, iterate through elements
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      extractOSCQueryNodes(item, collected, `${parentKey}[${index}]`);
    });
    return collected;
  }

  // If it has CONTENTS, recurse into it
  if (obj.CONTENTS && typeof obj.CONTENTS === "object") {
    for (const [key, value] of Object.entries(obj.CONTENTS)) {
      const newKey = parentKey ? `${parentKey}.${key}` : key;
      extractOSCQueryNodes(value, collected, newKey);
    }
  } else {
    // Otherwise, recursively traverse all properties
    for (const [key, value] of Object.entries(obj)) {
      if (key !== "CONTENTS") {
        // Skip CONTENTS as we handle it above
        const newKey = parentKey ? `${parentKey}.${key}` : key;
        extractOSCQueryNodes(value, collected, newKey);
      }
    }
  }

  return collected;
}

/**
 * Recursively extract Max objects from nested JSON structure
 * A Max object is identified by having a "path" property
 */
function extractMaxObjects(obj, collected = [], parentKey = "") {
  if (!obj || typeof obj !== "object") {
    return collected;
  }

  // Check if this is a Max object (has a "path" property)
  if (obj.path && typeof obj.path === "string") {
    collected.push({
      key: parentKey,
      obj: obj,
    });
    return collected;
  }

  // If it's an array, iterate through elements
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      extractMaxObjects(item, collected, `${parentKey}[${index}]`);
    });
    return collected;
  }

  // If it's an object, recursively traverse its properties
  for (const [key, value] of Object.entries(obj)) {
    const newKey = parentKey ? `${parentKey}.${key}` : key;
    extractMaxObjects(value, collected, newKey);
  }

  return collected;
}

/**
 * Load Max objects from JSON file or JSON string and create OSC methods
 * Handles nested JSON structures by recursively traversing the object tree
 */
function loadFromJSON(clientName, jsonPathOrData) {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  try {
    let jsonData;

    // Check if it's a file path or JSON string
    if (typeof jsonPathOrData === "string") {
      // Try to read as file first
      if (fs.existsSync(jsonPathOrData)) {
        const jsonContent = fs.readFileSync(jsonPathOrData, "utf8");
        jsonData = JSON.parse(jsonContent);
        logger(`Loading from file: ${jsonPathOrData}`);
      } else {
        // Try to parse as JSON string
        try {
          jsonData = JSON.parse(jsonPathOrData);
          logger("Loading from JSON string");
        } catch (parseError) {
          throw new Error(
            `Invalid file path or JSON string: ${jsonPathOrData}`
          );
        }
      }
    } else if (typeof jsonPathOrData === "object") {
      // Already parsed JSON object
      jsonData = jsonPathOrData;
      logger("Loading from JSON object");
    } else {
      throw new Error(
        "Invalid input: expected file path, JSON string, or JSON object"
      );
    }

    // Detect format: OSCQuery format has FULL_PATH and TYPE, Max format has path
    const isOSCQueryFormat =
      jsonData.FULL_PATH !== undefined || jsonData.CONTENTS !== undefined;

    let successCount = 0;
    let errorCount = 0;

    if (isOSCQueryFormat) {
      // OSCQuery server format (nested CONTENTS structure)
      logger("Detected OSCQuery server format");
      const nodes = extractOSCQueryNodes(jsonData);
      const objectCount = nodes.length;
      logger(
        `Creating OSCQuery methods from ${objectCount} nodes (including nested)...`
      );

      // Iterate through all extracted nodes and create OSC methods
      for (const { key, node } of nodes) {
        try {
          const oscPath = node.FULL_PATH;
          if (!oscPath || typeof oscPath !== "string") {
            logger(`Skipping ${key}: missing or invalid FULL_PATH`);
            errorCount++;
            continue;
          }

          const typeStr = node.TYPE;
          if (!typeStr) {
            logger(`Skipping ${key}: missing TYPE`);
            errorCount++;
            continue;
          }

          const oscType = parseOSCTypeString(typeStr);
          const access = parseOSCQueryAccess(node.ACCESS);
          const range = convertOSCQueryRange(node.RANGE);

          // Build arguments array
          const types = Array.isArray(oscType) ? oscType : [oscType];
          const ranges = Array.isArray(range) ? range : range ? [range] : [];
          const arguments_ = types.map((type, index) => {
            const arg = { type };
            if (ranges[index]) {
              arg.range = ranges[index];
            }
            return arg;
          });

          // Build method description
          const methodDesc = {
            description: node.DESCRIPTION || oscPath,
            access: access,
            arguments: arguments_,
          };

          // Add method to server
          state.server.addMethod(oscPath, methodDesc);

          // Set initial values
          if (node.VALUE && Array.isArray(node.VALUE)) {
            node.VALUE.forEach((value, index) => {
              if (value !== undefined && value !== null) {
                // Skip NIL/impulse types
                const argType = types[index];
                if (
                  argType !== OSCTypeSimple.NIL &&
                  argType !== OSCTypeSimple.TRUE
                ) {
                  state.server.setValue(oscPath, index, value);
                }
              }
            });
          }

          successCount++;
          const valueStr = node.VALUE ? JSON.stringify(node.VALUE) : "no value";
          logger(`Added: ${oscPath} (${typeStr}) = ${valueStr}`);
        } catch (error) {
          errorCount++;
          const errorMsg =
            error && error.message ? error.message : String(error);
          logger(`Failed to add ${key}: ${errorMsg}`);
          outletTo(2, "load_json_error", key, errorMsg);
        }
      }
    } else {
      // Max objects format (has "path" property)
      logger("Detected Max objects format");
      const maxObjects = extractMaxObjects(jsonData);
      const objectCount = maxObjects.length;
      logger(
        `Creating OSCQuery methods from ${objectCount} Max objects (including nested)...`
      );

      // Iterate through all extracted objects and create OSC methods
      for (const { key, obj } of maxObjects) {
        try {
          const oscPath = clientName + obj.path;
          if (!oscPath || typeof oscPath !== "string") {
            logger(`Skipping ${key}: missing or invalid path`);
            errorCount++;
            continue;
          }

          // live.menu -> force INT (menu index) so the web UI shows a dropdown
          // using parameter_range as the list of labels
          const isMenu =
            obj.maxclass === "live.menu" ||
            Array.isArray(obj.parameter_range);

          const oscType = isMenu
            ? OSCTypeSimple.INT
            : mapMaxTypeToOSCType(obj.type);

          const range = convertMaxRange(
            obj.range,
            obj.min,
            obj.max,
            obj.parameter_range
          );

          // Build method description (prefer parameter_longname for human-readable UI label)
          const methodDesc = {
            description:
              obj.parameter_longname ||
              obj.description ||
              `${obj.maxclass || "unknown"} - ${obj.varname || key}`,
            access: OSCQAccess.READWRITE, // Most Max objects are read/write
            arguments: [
              {
                type: oscType,
                ...(range && { range }),
              },
            ],
          };

          // Add method to server
          state.server.addMethod(oscPath, methodDesc);

          // Set initial value
          if (obj.value !== undefined && obj.value !== null) {
            // For bang/impulse types, we don't set a value
            if (oscType !== OSCTypeSimple.TRUE || obj.type !== "bang") {
              state.server.setValue(oscPath, 0, obj.value);
            }
          }

          successCount++;
          logger(`Added: ${oscPath} (${obj.type || "unknown"}) = ${obj.value}`);
        } catch (error) {
          errorCount++;
          const errorMsg =
            error && error.message ? error.message : String(error);
          logger(`Failed to add ${key}: ${errorMsg}`);
          outletTo(2, "load_json_error", key, errorMsg);
        }
      }
    }

    logger(
      `\nLoaded ${successCount} methods for client ${clientName} successfully${errorCount > 0 ? `, ${errorCount} errors` : ""
      }`
    );
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to load from JSON for client ${clientName}: ${errorMsg}`);
    outletTo(2, "load_json_failed", clientName, errorMsg);
  }
}

/**
 * Setup incoming OSC message handlers
 * Hooks into the OSC server and WebSocket server to capture incoming messages
 */
function setupIncomingMessageHandlers() {
  if (!state.server) {
    return;
  }

  try {
    // Hook into UDP OSC server messages
    // Access the private _oscServer property
    if (state.server._oscServer) {
      const oscServer = state.server._oscServer;

      // Get existing listeners to preserve them
      const existingListeners = oscServer.listeners("message");

      // Add our handler that forwards to Max (before existing handlers)
      oscServer.prependListener("message", (msg) => {
        if (!state.incomingMessages.enabled) {
          return; // Skip if incoming messages are disabled
        }

        const path = msg[0];
        const value = msg.slice(1);

        const messageObject = {
          path: path,
          value: value,
        };
        outletTo(1, messageObject);
      });

      logger("OSC message handler attached to UDP server");
    }

    // Hook into WebSocket OSC messages
    // Access the private _wsServer property
    if (state.server._wsServer) {
      const wsServer = state.server._wsServer;

      // Store original handler if it exists
      const originalHandler = wsServer._onOSCMessage;

      // Set our custom handler that wraps the original
      wsServer.setOSCMessageHandler((path, args) => {
        // Output to Max with osc_message tag (if enabled)

        if (state.incomingMessages.enabled) {
          let messageObject;
          if (Array.isArray(args)) {
            // If exactly one element, flatten; else keep as array
            messageObject = {
              path: path,
              value: args.length === 1 ? args[0] : args,
            };
          } else {
            messageObject = {
              path: path,
              value: args,
            };
          }
          outletTo(1, messageObject);
        }

        // Call original handler to maintain server functionality
        if (originalHandler) {
          originalHandler(path, args);
        }
      });

      logger("OSC message handler attached to WebSocket server");
    }
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger("Failed to setup incoming message handlers:", errorMsg);
  }
}

/**
 * Normalize a root path to always start with "/"
 */
function normalizeRootPath(rootPath) {
  if (!rootPath || typeof rootPath !== "string") {
    return null;
  }
  return rootPath.startsWith("/") ? rootPath : "/" + rootPath;
}

/**
 * Increment ref-count for a client root
 */
function trackClientRoot(rootPath) {
  const normalized = normalizeRootPath(rootPath);
  if (!normalized) return;
  state.clientRoots[normalized] = (state.clientRoots[normalized] || 0) + 1;
  logger(
    `Tracking client root ${normalized} (count=${state.clientRoots[normalized]})`
  );
}

/**
 * Decrement ref-count and remove root when no clients remain
 */
function releaseClientRoot(rootPath) {
  const normalized = normalizeRootPath(rootPath);
  if (!normalized) return;

  const current = state.clientRoots[normalized] || 0;
  if (current <= 0) {
    return;
  }

  const next = current - 1;
  if (next > 0) {
    state.clientRoots[normalized] = next;
    logger(`Client root ${normalized} still in use (count=${next})`);
    return;
  }

  delete state.clientRoots[normalized];

  try {
    if (state.server && typeof state.server.removeMethod === "function") {
      // Try both "/root" and "root" because load_from_json prefixes clientName without a leading slash
      const variants = [normalized];
      if (normalized.startsWith("/")) {
        variants.push(normalized.substring(1));
      }

      variants.forEach((p) => {
        try {
          state.server.removeMethod(p);
          logger(`Removed OSCQuery root for disconnected client: ${p}`);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          logger(`Failed to remove OSCQuery root ${p}:`, msg);
        }
      });
    }
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to remove OSCQuery root ${normalized}:`, errorMsg);
  }
}

/**
 * Attach cleanup to WebSocket disconnects so we remove OSCQuery roots
 */
function setupWebSocketDisconnectCleanup() {
  if (
    !state.server ||
    !state.server._wsServer ||
    !state.server._wsServer._wsServer
  ) {
    logger("WebSocket server not available for disconnect cleanup");
    return;
  }

  const rawWsServer = state.server._wsServer._wsServer;
  if (typeof rawWsServer.on !== "function") {
    logger("WebSocket server missing event emitter interface");
    return;
  }

  rawWsServer.on("connection", (ws, req) => {
    // Use request path (excluding query) as the client root, e.g. "/ClientName"
    const urlPath = req && req.url ? req.url.split("?")[0] : "";
    const pathParts = urlPath.split("/").filter(Boolean);
    const rootPath =
      pathParts.length > 0 ? normalizeRootPath(pathParts[0]) : null;

    if (!rootPath) {
      logger("WebSocket client connected without root path");
      return;
    }

    trackClientRoot(rootPath);

    const cleanup = () => {
      releaseClientRoot(rootPath);
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}

/**
 * Start the OSCQuery server
 * Extracted to a function so it can be called from handler or autostart
 */
async function startServer() {
  if (state.started) {
    logger("Server already started");
    return;
  }

  try {
    state.server = new OSCQueryServer(state.options);
    const hostInfo = await state.server.start();
    state.hostInfo = hostInfo;
    state.started = true;

    // Setup incoming message handlers after server starts
    setupIncomingMessageHandlers();
    setupWebSocketDisconnectCleanup();

    logger("Server started");
    logger("Root Description:", state.options.rootDescription);
    logger("Host Info:", JSON.stringify(hostInfo, null, 2));
    outletTo(0, "started");
    outletTo(3, hostInfo);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger("Failed to start server:", errorMsg);
    outletTo(2, "start_failed", errorMsg);
  }
}

// Initialize Max API handlers
maxAPI.addHandler("start", startServer);

maxAPI.addHandler("stop", async () => {
  if (!state.started || !state.server) {
    logger("Server not started");
    return;
  }

  try {
    await state.server.stop();
    state.started = false;
    state.server = null;
    state.hostInfo = null;

    logger("Server stopped");
    outletTo(0, "stopped");
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger("Failed to stop server:", errorMsg);
    outletTo(2, "stop_failed", errorMsg);
  }
});

maxAPI.addHandler("add_method", (path, ...args) => {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  if (!path || typeof path !== "string") {
    logger("Path is required for add_method");
    outletTo(2, "invalid_path", "Path is required");
    return;
  }

  try {
    // Parse method description from arguments
    // Format: add_method path [description] [access] [arg_type1 [range1]] [arg_type2 [range2]] ...
    const methodDesc = {
      description: undefined,
      access: OSCQAccess.READWRITE,
      arguments: [],
    };

    let argIndex = 0;

    // First argument might be description (string)
    if (
      args.length > argIndex &&
      typeof args[argIndex] === "string" &&
      !args[argIndex].match(
        /^(I|INT|F|FLOAT|S|STRING|B|BOOL|T|TRUE|FALSE|N|NULL|IMPULSE|BANG|READONLY|WRITEONLY|READWRITE|RO|WO|RW)$/i
      )
    ) {
      methodDesc.description = args[argIndex];
      argIndex++;
    }

    // Next might be access
    if (
      args.length > argIndex &&
      typeof args[argIndex] === "string" &&
      args[argIndex].match(/^(READONLY|WRITEONLY|READWRITE|RO|WO|RW)$/i)
    ) {
      methodDesc.access = parseAccess(args[argIndex]);
      argIndex++;
    }

    // Parse arguments
    while (argIndex < args.length) {
      const argType = parseOSCType(args[argIndex]);
      argIndex++;

      const argDesc = { type: argType };

      // Check if next argument is a range
      if (argIndex < args.length) {
        const range = parseRange(args, argIndex);
        if (range) {
          argDesc.range = range;
          if (range.vals) {
            argIndex += 1 + range.vals.length; // Skip "vals" and all values
          } else {
            argIndex += 2; // Skip min and max
          }
        }
      }

      methodDesc.arguments.push(argDesc);
    }

    state.server.addMethod(path, methodDesc);
    logger(`Method added: ${path}`);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to add method ${path}:`, errorMsg);
    outletTo(2, "add_method_failed", path, errorMsg);
  }
});

maxAPI.addHandler("remove_method", (path) => {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  if (!path || typeof path !== "string") {
    logger("Path is required for remove_method");
    outletTo(2, "invalid_path", "Path is required");
    return;
  }

  try {
    state.server.removeMethod(path);
    logger(`Method removed: ${path}`);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to remove method ${path}:`, errorMsg);
    outletTo(2, "remove_method_failed", path, errorMsg);
  }
});

maxAPI.addHandler("set_value", (path, argIndex, value) => {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  if (!path || typeof path !== "string") {
    logger("Path is required for set_value");
    outletTo(2, "invalid_path", "Path is required");
    return;
  }

  const index = typeof argIndex === "number" ? argIndex : 0;
  const val = value !== undefined ? value : argIndex;

  try {
    state.server.setValue(path, index, val);
    logger(`Value set: ${path}[${index}] = ${val}`);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to set value for ${path}:`, errorMsg);
    outletTo(2, "set_value_failed", path, errorMsg);
  }
});

maxAPI.addHandler("send_value", (path, ...args) => {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  if (!path || typeof path !== "string") {
    logger("Path is required for send_value");
    outletTo(2, "invalid_path", "Path is required");
    return;
  }

  try {
    // sendValue broadcasts to WebSocket clients
    state.server.sendValue(path, ...args);
    logger(`Value sent: ${path}`, ...args);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to send value for ${path}:`, errorMsg);
    outletTo(2, "send_value_failed", path, errorMsg);
  }
});

maxAPI.addHandler("unset_value", (path, argIndex) => {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  if (!path || typeof path !== "string") {
    logger("Path is required for unset_value");
    outletTo(2, "invalid_path", "Path is required");
    return;
  }

  const index = typeof argIndex === "number" ? argIndex : 0;

  try {
    state.server.unsetValue(path, index);
    logger(`Value unset: ${path}[${index}]`);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to unset value for ${path}:`, errorMsg);
    outletTo(2, "unset_value_failed", path, errorMsg);
  }
});

maxAPI.addHandler("get_host_info", () => {
  if (!state.started || !state.hostInfo) {
    logger("Server not started or host info not available");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  outletTo(3, state.hostInfo);
});

maxAPI.addHandler("is_started", () => {
  outletTo(0, state.started ? "started" : "stopped");
});

maxAPI.addHandler("load_from_json", (clientName, jsonPathOrData) => {
  if (!jsonPathOrData) {
    logger("Path or JSON data is required for load_from_json");
    outletTo(2, "invalid_input", "Path or JSON data is required");
    return;
  }
  if (!clientName || typeof clientName !== "string") {
    logger("Client name is required for load_from_json");
    outletTo(2, "invalid_client", "Client name is required");
    return;
  }
  if (!jsonPathOrData) {
    logger("Path or JSON data is required for load_from_json");
    outletTo(2, "invalid_input", "Path or JSON data is required");
    return;
  }
  loadFromJSON(clientName, jsonPathOrData);
});

maxAPI.addHandler("updated_value", (clientName, jsonPathOrData) => {
  if (!state.started || !state.server) {
    logger("Server not started. Call 'start' first.");
    outletTo(2, "not_started", "Server not started");
    return;
  }

  if (!clientName || typeof clientName !== "string") {
    logger("Client name is required for updated_value");
    outletTo(2, "invalid_client", "Client name is required");
    return;
  }

  if (!jsonPathOrData) {
    logger("Path or JSON data is required for updated_value");
    outletTo(2, "invalid_input", "Path or JSON data is required");
    return;
  }

  let payload = jsonPathOrData;

  if (typeof jsonPathOrData === "string") {
    try {
      payload = JSON.parse(jsonPathOrData);
    } catch (error) {
      const errorMsg = error && error.message ? error.message : String(error);
      logger("Invalid JSON for updated_value:", errorMsg);
      outletTo(2, "invalid_json", errorMsg);
      return;
    }
  }

  if (!payload || typeof payload !== "object") {
    logger("Invalid payload for updated_value");
    outletTo(2, "invalid_payload", "Payload must be an object");
    return;
  }

  const receivedDict = payload;
  const path = receivedDict && receivedDict.path;
  const value = receivedDict ? receivedDict.value : undefined;

  if (!path || typeof path !== "string") {
    logger("Path is required in receivedDict for updated_value");
    outletTo(2, "invalid_path", "Path is required in receivedDict");
    return;
  }

  const oscPath = "/" + clientName + path;
  const values = Array.isArray(value) ? value : [value];

  try {
    values.forEach((val, index) => {
      state.server.setValue(oscPath, index, val);
    });
    state.server.sendValue(oscPath, ...values);
    logger(`Updated value for ${oscPath}:`, ...values);
  } catch (error) {
    const errorMsg = error && error.message ? error.message : String(error);
    logger(`Failed to update value for ${oscPath}:`, errorMsg);
    outletTo(2, "updated_value_failed", oscPath, errorMsg);
  }
});

maxAPI.addHandler("logging", (enabled) => {
  if (enabled === "true" || enabled === true || enabled === 1) {
    state.logging.enabled = true;
    logger("Logging enabled");
  } else if (enabled === "false" || enabled === false || enabled === 0) {
    state.logging.enabled = false;
    // Use maxAPI.post directly here since logging is disabled
    maxAPI.post("Logging disabled");
  } else {
    logger("Logging state:", state.logging.enabled ? "enabled" : "disabled");
  }
});

maxAPI.addHandler("log_tag", (tag) => {
  if (tag === null || tag === undefined || tag === "") {
    state.logging.tag = null;
    logger("Log tag cleared");
  } else {
    state.logging.tag = String(tag);
    logger("Log tag set to:", state.logging.tag);
  }
});

maxAPI.addHandler("incoming_messages", (enabled) => {
  if (enabled === "true" || enabled === true || enabled === 1) {
    state.incomingMessages.enabled = true;
    logger("Incoming OSC messages forwarding enabled");
  } else if (enabled === "false" || enabled === false || enabled === 0) {
    state.incomingMessages.enabled = false;
    logger("Incoming OSC messages forwarding disabled");
  } else {
    logger(
      "Incoming messages state:",
      state.incomingMessages.enabled ? "enabled" : "disabled"
    );
  }
});

// Initialize
logger("OSCQuery Server initialized");
outletTo(0, "stopped"); // Initial state: stopped

// Autostart if enabled (default: true)
if (state.options.autostart) {
  logger("Autostart enabled, starting server...");
  startServer();
}
