const swaggerJSDoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "DFS E-commerce API",
      version: "1.0.0",
      description: "OpenAPI documentation for the multi-role e-commerce backend.",
    },
    servers: [
      { url: process.env.API_PUBLIC_URL || "http://localhost:5000/api", description: "API server" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Auth" },
      { name: "Products" },
      { name: "Cart" },
      { name: "Checkout" },
      { name: "Orders" },
      { name: "Shop" },
      { name: "Admin" },
      { name: "Payments" },
    ],
    paths: {
      "/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Login with email/username and password",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["identifier", "password"],
                  properties: {
                    identifier: { type: "string" },
                    password: { type: "string", format: "password" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Authenticated" },
            401: { description: "Invalid credentials" },
          },
        },
      },
      "/products": {
        get: {
          tags: ["Products"],
          summary: "List products",
          security: [],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Product list" },
          },
        },
      },
      "/checkout/preview": {
        post: {
          tags: ["Checkout"],
          summary: "Preview checkout totals",
          responses: {
            200: { description: "Checkout preview" },
            401: { description: "Unauthorized" },
          },
        },
      },
      "/checkout/confirm": {
        post: {
          tags: ["Checkout"],
          summary: "Create one order per shop",
          responses: {
            200: { description: "Orders created" },
            409: { description: "Stock or flash sale conflict" },
          },
        },
      },
    },
  },
  apis: [],
});

function mountSwagger(app) {
  app.get("/api/docs.json", (req, res) => res.json(swaggerSpec));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

module.exports = {
  mountSwagger,
  swaggerSpec,
};
