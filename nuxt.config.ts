/**
 * Domain-Agnostic Metaontology - Nuxt Layer
 *
 * Provides the universal business modeling vocabulary (Context, Thing, Persona,
 * Action, Workflow, Interface, Event, Measure, Port) as a reusable Nuxt layer.
 *
 * Pure ontology code lives in the companion @businessmaps/metaontology package
 * (zero Vue deps). Vue-reactive composables live in ./composables/ (auto-imported
 * by Nuxt).
 *
 * Consumers extend this layer and provide their own domain models and config.
 */
export default defineNuxtConfig({
  // Composables in ./composables/ are auto-imported by Nuxt layer convention.
  // Pure ontology code is imported explicitly via relative paths.
})
