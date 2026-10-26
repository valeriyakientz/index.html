import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT) || 4173;
const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
};

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
}

async function readJson(request) {
    let body = "";
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 16_384) throw new Error("Request body is too large.");
    }
    return JSON.parse(body || "{}");
}

async function validateAddress(request, response) {
    const apiKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
    if (!apiKey) {
        sendJson(response, 503, { error: "Address validation is not configured on the server." });
        return;
    }

    let payload;
    try {
        payload = await readJson(request);
    } catch {
        sendJson(response, 400, { error: "Invalid address request." });
        return;
    }

    const address = payload.address || {};
    const streetLine = [address.street, address.houseNumber].filter((line) => typeof line === "string" && line.trim()).join(" ");
    const addressLines = [streetLine, address.apartment, address.country]
        .filter((line) => typeof line === "string" && line.trim());
    if (!addressLines.length || !address.city?.trim() || !address.country?.trim()) {
        sendJson(response, 400, { error: "Enter a street, city, and country." });
        return;
    }

    try {
        const providerResponse = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${encodeURIComponent(apiKey)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                address: {
                    regionCode: address.countryCode || (/^[a-z]{2}$/i.test(address.country) ? address.country.toUpperCase() : undefined),
                    addressLines,
                    locality: address.city,
                    postalCode: address.postalCode || undefined,
                    region: address.region || undefined
                }
            })
        });

        const providerResult = await providerResponse.json();
        if (!providerResponse.ok) {
            sendJson(response, 502, { error: "The address validation provider could not verify this address." });
            return;
        }

        const result = providerResult.result || {};
        const verdict = result.verdict || {};
        const postalAddress = result.address?.postalAddress || {};
        const acceptedGranularity = ["PREMISE", "SUB_PREMISE", "ROUTE"].includes(verdict.validationGranularity);

        sendJson(response, 200, {
            valid: verdict.addressComplete === true
                && acceptedGranularity
                && verdict.hasUnconfirmedComponents !== true,
            formattedAddress: result.address?.formattedAddress || "",
            validationGranularity: verdict.validationGranularity || "UNKNOWN",
            addressLines: postalAddress.addressLines || [],
            locality: postalAddress.locality || "",
            postalCode: postalAddress.postalCode || "",
            regionCode: postalAddress.regionCode || "",
            hasInferredComponents: verdict.hasInferredComponents === true,
            hasReplacedComponents: verdict.hasReplacedComponents === true,
            hasUnconfirmedComponents: verdict.hasUnconfirmedComponents === true
        });
    } catch {
        sendJson(response, 502, { error: "Address validation is temporarily unavailable." });
    }
}

const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (requestUrl.pathname === "/api/address-validation" && request.method === "POST") {
        await validateAddress(request, response);
        return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end("Method not allowed");
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
    } catch {
        response.writeHead(400).end("Invalid path");
        return;
    }

    const filePath = resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
    }

    try {
        const contents = await readFile(filePath);
        response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream" });
        response.end(request.method === "HEAD" ? undefined : contents);
    } catch {
        response.writeHead(404).end("Not found");
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`LÆTITIA BILL is running at http://127.0.0.1:${port}`);
});