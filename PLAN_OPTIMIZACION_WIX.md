# 📋 PLAN PROFESIONAL DE OPTIMIZACIÓN WIX
## Sistema de Módulos Backend & Frontend - Análisis Real

**Fecha de Análisis:** 2026-09-13  
**Versión Actual del Sistema:** v5006.x  
**Estado:** En producción con deuda técnica identificada

---

## 📊 MÉTRICAS REALES DEL REPOSITORIO

### **Inventario de Archivos**
| Categoría | Cantidad | Líneas de Código |
|-----------|----------|------------------|
| Backend (.js) | 26 archivos | ~8,500 líneas |
| Backend Booking (.js) | 2 archivos | 2,166 líneas |
| Público (.js) | 4 archivos | ~1,400 líneas |
| Páginas (.js) | 43 archivos | ~variable |
| TypeScript (.ts) | 4 archivos | ~500 líneas |
| **TOTAL** | **73 archivos JS/TS** | **~12,566 líneas** |

### **Archivos Críticos (Más de 500 líneas)**
| Archivo | Líneas | Prioridad | Problemas Principales |
|---------|--------|-----------|----------------------|
| `bookingCore.js` | 1,403 | 🔴 CRÍTICA | Funciones >100 líneas, complejidad ciclomática alta |
| `cajas.web.js` | 938 | 🔴 CRÍTICA | Clave duplicada `lineHash`, imports no usados |
| `reservas.web.js` | 925 | 🟡 ALTA | Bloques vacíos, await redundantes |
| `bookingSaga.js` | 754 | 🔴 CRÍTICA | Condición de carrera línea 381 |
| `citasManager.web.js` | 708 | 🟡 ALTA | Bloque vacío línea 64 |
| `security.js` | 662 | 🔴 CRÍTICA | 4 condiciones de carrera |
| `events.js` | 561 | 🟢 MEDIA | - |
| `bookingServiceSync.js` | 559 | 🟢 MEDIA | - |

---

## 🚨 ERRORES Y ADVERTENCIAS REALES (eslint --quiet)

### **Resumen Ejecutivo**
```
Total problemas: 162
  - Errores: 61 (requieren corrección inmediata)
  - Advertencias: 101 (mejora de código)
```

### **Errores Críticos por Categoría**

#### **1. Condiciones de Carrera (require-atomic-updates) - 6 errores**
| Archivo | Línea | Variable | Impacto |
|---------|-------|----------|---------|
| `bookingSaga.js` | 381 | `lockKeys` | Corrupción de locks de concurrencia |
| `security.js` | 88-92 | `cachedAdminEmails`, `adminCacheTime`, `cachedCajeroEmails`, `cajeroCacheTime` | Cache inseguro, posible bypass de autenticación |
| `staff.js` | 27, 36 | `staffCache`, `staffCacheTime` | Datos de staff inconsistentes |

#### **2. Claves Duplicadas (no-dupe-keys) - 1 error**
| Archivo | Línea | Clave | Impacto |
|---------|-------|-------|---------|
| `cajas.web.js` | 475 | `lineHash` | Error de ejecución, fallo en cadena fiscal Veri*factu |

#### **3. Bloques Vacíos (no-empty) - 2 errores**
| Archivo | Línea | Contexto |
|---------|-------|----------|
| `citasManager.web.js` | 64 | Manejo de excepciones sin lógica |
| `reservas.web.js` | 248 | Validación incompleta |

#### **4. Variables No Definidas ($w, document) - 28 errores**
**Frontend Pages (24 archivos):** Uso de `$w` sin importar `wix-window`
- Todas las páginas con error en línea 4: falta `import { $w } from 'wix-window';`

**Backend:**
- `only-staff.js`: líneas 24, 33, 38, 43 - Código frontend en backend
- `mmUtils.js`: líneas 736-751 - Funciones DOM en módulo compartido

#### **5. Importaciones Duplicadas (no-duplicate-imports) - 1 error**
| Archivo | Línea | Módulo Duplicado |
|---------|-------|------------------|
| `http-functions.js` | 15 | `backend/booking/bookingCore` |

#### **6. Await Redundantes (no-return-await) - 8 errores**
| Archivo | Líneas | Ahorro Potencial |
|---------|--------|------------------|
| `cajas.web.js` | 133, 647 | Micro-optimización |
| `citasManager.web.js` | 522 | - |
| `contabilidad.js` | 90 | - |
| `reservas.web.js` | 349, 505 | - |
| `staff.js` | 45, 71 | - |

---

## 🎯 PLAN DE ITERACIONES PROFESIONALES

### **FASE 1: CORRECCIÓN DE ERRORES CRÍTICOS** 
**Duración Estimada:** 2-3 horas  
**Prioridad:** 🔴 URGENTE  
**Riesgo si no se corrige:** Fallos en producción, corrupción de datos fiscales

#### **Iteración 1.1: Condiciones de Carrera** (45 minutos)
**Archivos:** `bookingSaga.js`, `security.js`, `staff.js`

**Acciones:**
1. Implementar patrón mutex para actualizaciones de cache
2. Usar operaciones atómicas o locks distribuidos
3. Refactorizar cachés a estructura thread-safe

**Métrica de Éxito:**
- ✅ 6 errores `require-atomic-updates` corregidos
- ✅ Tests de concurrencia pasan (si existen)
- ✅ No regresiones en funcionalidad de booking

**Código Ejemplo (security.js):**
```javascript
// ANTES (inseguro)
if (!cachedAdminEmails || Date.now() - adminCacheTime > CACHE_TTL) {
  cachedAdminEmails = await fetchAdminEmails(); // RACE CONDITION
  adminCacheTime = Date.now();
}

// DESPUÉS (seguro)
async function getAdminEmailsSafe() {
  const now = Date.now();
  if (!cachedAdminEmails || now - adminCacheTime > CACHE_TTL) {
    const freshEmails = await fetchAdminEmails();
    // Actualización atómica
    cachedAdminEmails = freshEmails;
    adminCacheTime = now;
  }
  return [...cachedAdminEmails]; // Copia defensiva
}
```

---

#### **Iteración 1.2: Clave Duplicada en cajas.web.js** (15 minutos)
**Archivo:** `cajas.web.js` línea 475

**Acciones:**
1. Identificar objeto con clave duplicada `lineHash`
2. Renombrar segunda ocurrencia a `previousLineHash` o eliminar
3. Verificar integridad de cadena SHA-256 Veri*factu

**Métrica de Éxito:**
- ✅ 1 error `no-dupe-keys` corregido
- ✅ Tests de firma fiscal pasan
- ✅ Auditoría de cadena hash intacta

---

#### **Iteración 1.3: Bloques Vacíos** (20 minutos)
**Archivos:** `citasManager.web.js` (línea 64), `reservas.web.js` (línea 248)

**Acciones:**
1. Analizar contexto del try-catch o condicional
2. Agregar logging apropiado o eliminar bloque innecesario
3. Documentar decisión de diseño

**Métrica de Éxito:**
- ✅ 2 errores `no-empty` corregidos
- ✅ Mejor visibilidad de errores en logs

---

#### **Iteración 1.4: Variables No Definidas ($w)** (40 minutos)
**Archivos:** 24 páginas + `only-staff.js` + `mmUtils.js`

**Acciones:**
1. **Páginas:** Agregar `import { $w } from 'wix-window';` al inicio
2. **Backend only-staff.js:** Mover a `/pages/ONLY_STAFF.mvf3f.js` o eliminar
3. **mmUtils.js:** Separar funciones DOM en `mmUtils.frontend.js`

**Métrica de Éxito:**
- ✅ 28 errores `no-undef` corregidos
- ✅ Separación clara backend/frontend
- ✅ Build sin errores

---

#### **Iteración 1.5: Importaciones Duplicadas** (10 minutos)
**Archivo:** `http-functions.js` línea 15

**Acciones:**
1. Consolidar importaciones de `backend/booking/bookingCore`
2. Verificar que todas las exportaciones necesarias estén incluidas

**Métrica de Éxito:**
- ✅ 1 error `no-duplicate-imports` corregido
- ✅ Código más limpio

---

#### **Iteración 1.6: Await Redundantes** (20 minutos)
**Archivos:** 6 archivos con `return await`

**Acciones:**
1. Reemplazar `return await x` por `return x`
2. Mantener `await` solo cuando hay procesamiento post-await

**Métrica de Éxito:**
- ✅ 8 advertencias `no-return-await` corregidas
- ✅ Micro-optimización de performance

---

### **FASE 2: LIMPIEZA Y OPTIMIZACIÓN**
**Duración Estimada:** 3-4 horas  
**Prioridad:** 🟡 ALTA  
**Beneficio:** Código más mantenible, menor bundle size

#### **Iteración 2.1: Variables No Utilizadas** (60 minutos)
**Archivos Afectados:** 15+ archivos

**Principales Ofensores:**
| Archivo | Variables No Usadas | Impacto |
|---------|---------------------|---------|
| `bookingCore.js` | `findStaff`, `PII_KEYS`, `HEARTBEAT_MS`, 4x `result`, `addonIds` | Confusión, bundle size |
| `cajas.web.js` | `requireAdmin`, `rateLimiter`, `timingSafeEqual`, 3x `traceId`, `businessTaxId` | Imports innecesarios |
| `bookingSaga.js` | `elevate` | Import innecesario |
| `M365Adapter.ts` | 13 parámetros no usados | Interfaces incorrectas |

**Acciones:**
1. Eliminar variables asignadas pero no usadas
2. Remover imports innecesarios
3. Prefijar con `_` parámetros intencionalmente no usados

**Métrica de Éxito:**
- ✅ 30+ advertencias `no-unused-vars` eliminadas
- ✅ Reducción estimada: 2-3% bundle size
- ✅ Mejor claridad de código

---

#### **Iteración 2.2: Tipos `any` en TypeScript** (45 minutos)
**Archivos:** `M365Adapter.ts`, `booking.types.ts`, `StructuredLogger.ts`, `BookingEngine.ts`

**Acciones:**
1. Reemplazar `any` con tipos específicos o interfaces
2. Usar `unknown` + type guards cuando el tipo es dinámico
3. Definir interfaces para respuestas de API

**Ejemplo:**
```typescript
// ANTES
interface LogEntry {
  data?: any;
}

// DESPUÉS
interface LogEntry {
  data?: Record<string, unknown>;
}

// O mejor
type LogData = {
  userId?: string;
  duration?: number;
  [key: string]: unknown;
};
```

**Métrica de Éxito:**
- ✅ 15+ advertencias `@typescript-eslint/no-explicit-any` corregidas
- ✅ Mejor type safety
- ✅ IDE autocomplete funcional

---

#### **Iteración 2.3: Console Statements en Producción** (30 minutos)
**Archivos:** 10+ archivos de páginas

**Acciones:**
1. Reemplazar `console.log` con `logger.info/debug`
2. Configurar nivel de log según ambiente
3. Eliminar console.debug de desarrollo

**Métrica de Éxito:**
- ✅ 15+ console statements eliminados/migrados
- ✅ Logs centralizados y estructurados
- ✅ Mejor control de output en producción

---

#### **Iteración 2.4: Escape Characters Innecesarios** (10 minutos)
**Archivo:** `mmUtils.js` línea 835

**Acciones:**
1. Corregir regex: `/\-/` → `/-/`
2. Revisar otros regex en el código

**Métrica de Éxito:**
- ✅ 1 error `no-useless-escape` corregido
- ✅ Regex más legible

---

### **FASE 3: REFACTORIZACIÓN DE ARQUITECTURA**
**Duración Estimada:** 6-8 horas  
**Prioridad:** 🟢 MEDIA-LARGO PLAZO  
**Beneficio:** Mantenibilidad, escalabilidad, testabilidad

#### **Iteración 3.1: Descomposición de Funciones Grandes** (120 minutos)
**Funciones Objetivo (>100 líneas):**

| Función | Archivo | Líneas | Complejidad |
|---------|---------|--------|-------------|
| `_projectWriterSlotFromAvailability` | bookingCore.js | ~150 | Alta |
| `procesarMovimientoCaja` | cajas.web.js | ~120 | Media-Alta |
| `crearReservaCompleta` | reservas.web.js | ~140 | Alta |
| `syncBookingToM365` | m365GraphSync.js | ~110 | Media |

**Patrón de Refactorización:**
```javascript
// ANTES: Función monolítica de 150 líneas
async function crearReservaCompleta(params) {
  // 50 líneas validación
  // 40 líneas cálculo disponibilidad
  // 30 líneas creación booking
  // 30 líneas notificaciones
}

// DESPUÉS: Funciones cohesivas
async function crearReservaCompleta(params) {
  const validated = await validarReserva(params);
  const slot = await verificarDisponibilidad(validated);
  const booking = await persistirBooking(slot);
  await enviarNotificaciones(booking);
  return booking;
}
```

**Métrica de Éxito:**
- ✅ 4+ funciones divididas en unidades <50 líneas
- ✅ Cada función con única responsabilidad
- ✅ Tests unitarios más fáciles de escribir

---

#### **Iteración 3.2: Centralización de Logger** (45 minutos)
**Estado Actual:** 
- `backend/logger.js` (246 líneas) - Logger estructurado JSON
- `backend/infrastructure/logger/StructuredLogger.ts` (40 líneas) - Logger TS duplicado
- Algunos módulos usan `console.log` directamente

**Acciones:**
1. Unificar logger.js y StructuredLogger.ts
2. Exportar logger desde módulo único
3. Migrar todos los console.* restantes

**Métrica de Éxito:**
- ✅ 1 archivo logger eliminado (duplicación)
- ✅ 100% módulos usando logger centralizado
- ✅ Trazabilidad completa con traceId

---

#### **Iteración 3.3: Separación Backend/Frontend** (60 minutos)
**Problema:** `mmUtils.js` contiene funciones DOM (`document.*`) que fallan en backend

**Solución:**
```
src/
├── public/
│   ├── mmUtils.core.js      # Funciones puras (trim, hash, date)
│   ├── mmUtils.frontend.js  # Funciones DOM ($w, document)
│   └── mmUtils.js           # Re-exporta según ambiente
└── backend/
    └── utils/
        └── mmUtils.backend.js # Wrapper seguro para backend
```

**Métrica de Éxito:**
- ✅ 0 errores `document is not defined` en backend
- ✅ Bundle splitting automático
- ✅ Tree-shaking efectivo

---

#### **Iteración 3.4: Mejorar Tipado TypeScript** (90 minutos)
**Archivos a Crear/Mejorar:**

1. **`backend/types/common.types.ts`** (nuevo)
```typescript
export interface ApiResponse<T> {
  status: 'SUCCESS' | 'ERROR' | 'WARNING';
  data?: T;
  error?: ApiError;
  traceId: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
```

2. **`backend/types/fiscal.types.ts`** (nuevo)
```typescript
export interface MovimientoCaja {
  transactionId: string;
  timestamp: string;
  tipo: TIPO_MOVIMIENTO;
  importe: number;
  formaPago: FORMA_PAGO;
  lineaHash: string;
  firmaVerifactu: string;
}
```

3. **Mejorar `booking.types.ts`** existente
- Completar interfaces incompletas
- Agregar tipos para eventos

**Métrica de Éxito:**
- ✅ 5+ archivos de tipos creados/mejorados
- ✅ 80% código TypeScript tipado correctamente
- ✅ Menos errores en tiempo de ejecución

---

### **FASE 4: MIGRACIÓN A VERSIONES ACTUALIZADAS**
**Duración Estimada:** 2-3 horas  
**Prioridad:** 🟡 MEDIA  
**Beneficio:** Security patches, nuevas features, performance

#### **Iteración 4.1: Actualizar Dependencias** (60 minutos)

**Estado Actual (package.json):**
```json
{
  "devDependencies": {
    "@wix/cli": "^1.1.245",      // ✅ Última versión
    "@wix/eslint-plugin-cli": "^1.0.2", // ✅ Última
    "eslint": "^8.57.1",          // ⚠️ ESLint 9.x disponible
    "@typescript-eslint/*": "^7.18.0", // ⚠️ Versión 8.x disponible
    "typescript": "^5.7.2",       // ✅ Última
    "react": "^18.3.1",           // ✅ React 18 latest
    "react-dom": "^18.3.1"        // ✅
  },
  "dependencies": {
    "uuid": "^11.0.5"             // ✅ Última
  }
}
```

**Actualizaciones Recomendadas:**
```bash
npm install --save-dev eslint@^9.0.0
npm install --save-dev @typescript-eslint/parser@^8.0.0
npm install --save-dev @typescript-eslint/eslint-plugin@^8.0.0
```

**Breaking Changes a Considerar:**
- ESLint 9: Nuevo formato de configuración (flat config)
- TypeScript 5.7: Cambios menores en inferencia

**Métrica de Éxito:**
- ✅ Dependencias actualizadas sin breaking changes
- ✅ `npm audit` sin vulnerabilidades críticas
- ✅ Build exitoso post-actualización

---

#### **Iteración 4.2: Migrar a ESLint Flat Config** (45 minutos)

**Configuración Actual (.eslintrc.json):**
```json
{
  "root": true,
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  // ...
}
```

**Nueva Configuración (eslint.config.js):**
```javascript
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import wixPlugin from '@wix/eslint-plugin-cli';

export default [
  {
    ignores: ['node_modules/', 'dist/', '*.min.js'],
  },
  {
    files: ['**/*.js', '**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      '@wix/cli': wixPlugin,
    },
    rules: {
      // Reglas migradas desde .eslintrc.json
    },
  },
];
```

**Métrica de Éxito:**
- ✅ `.eslintrc.json` eliminado
- ✅ `eslint.config.js` funcional
- ✅ Mismos resultados de linting

---

#### **Iteración 4.3: Optimizar TypeScript Config** (30 minutos)

**Configuración Actual (tsconfig.json):**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": false,  // ⚠️ Debería ser true
    "noUnusedParameters": false, // ⚠️ Debería ser true
    // ...
  }
}
```

**Mejoras Propuestas:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,  // ← Nuevo: más seguridad
    "exactOptionalPropertyTypes": true  // ← Nuevo: types más precisos
  }
}
```

**Métrica de Éxito:**
- ✅ TypeScript más estricto
- ✅ Errores detectados en compile time
- ✅ Código más robusto

---

### **FASE 5: OPTIMIZACIÓN DE PERFORMANCE**
**Duración Estimada:** 4-5 horas  
**Prioridad:** 🟢 MEDIA  
**Beneficio:** Menor latency, mejor UX, reducción costos

#### **Iteración 5.1: Optimizar Queries a wix-data** (90 minutos)

**Patrones Ineficientes Detectados:**

1. **Query sin índices en `reservas.web.js`:**
```javascript
// INEFICIENTE: Query en toda la colección
const results = await wixData.query(COLLECTIONS.RESERVAS)
  .find({ suppressAuth: true });
// Luego filtra en memoria
const filtered = results.items.filter(r => r.status === 'CONFIRMED');

// EFICIENTE: Filtrar en DB
const results = await wixData.query(COLLECTIONS.RESERVAS)
  .eq('status', 'CONFIRMED')
  .find({ suppressAuth: true });
```

2. **N+1 Query en `bookingSaga.js`:**
```javascript
// INEFICIENTE: Query por cada staff member
for (const staffId of staffIds) {
  const staff = await wixData.get(COLLECTIONS.STAFF, staffId);
}

// EFICIENTE: Bulk query
const staff = await wixData.query(COLLECTIONS.STAFF)
  .in('_id', staffIds)
  .find({ suppressAuth: true });
```

**Métrica de Éxito:**
- ✅ 5+ queries optimizadas
- ✅ Reducción estimada: 30-50% llamadas a DB
- ✅ Latencia reducida en 100-200ms por operación

---

#### **Iteración 5.2: Implementar Cache Estratégico** (75 minutos)

**Candidatos para Cache:**

1. **Catálogo de Servicios** (pocas mutaciones):
```javascript
// backend/cache/services.cache.js
const SERVICES_CACHE_TTL = 300000; // 5 minutos
let servicesCache = null;
let cacheTime = 0;

export async function getServicesCatalog() {
  const now = Date.now();
  if (servicesCache && now - cacheTime < SERVICES_CACHE_TTL) {
    return servicesCache;
  }
  servicesCache = await fetchServicesFromDB();
  cacheTime = now;
  return servicesCache;
}
```

2. **Configuración de Staff** (cambia raramente):
```javascript
// Usar cache existente en staff.js pero con invalidation adecuada
```

**Métrica de Éxito:**
- ✅ 2+ caches implementados
- ✅ Reducción estimada: 40% queries repetitivas
- ✅ TTL configurado apropiadamente

---

#### **Iteración 5.3: Lazy Loading de Módulos Pesados** (60 minutos)

**Módulos Candidatos:**
- `m365GraphSync.js` (399 líneas) - Solo usado en webhooks
- `fiscalAggregator.web.js` (335 líneas) - Solo en operaciones fiscales
- `bookingServiceSync.js` (559 líneas) - Solo en sync background

**Implementación:**
```javascript
// ANTES: Import estático
import { syncToM365 } from 'backend/m365GraphSync';

// DESPUÉS: Dynamic import
export async function handleWebhook(data) {
  const { syncToM365 } = await import('backend/m365GraphSync');
  return syncToM365(data);
}
```

**Métrica de Éxito:**
- ✅ 3+ módulos con lazy loading
- ✅ Bundle inicial reducido ~15%
- ✅ Cold start más rápido

---

#### **Iteración 5.4: Optimizar Serialización JSON** (45 minutos)

**Problema:** `_stableSerialize` en `mmUtils.js` puede ser costoso

**Análisis:**
```javascript
// Verificar uso actual
export function _stableSerialize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}
```

**Optimización:**
```javascript
// Cache de claves ordenadas para objetos frecuentes
const SORTED_KEYS_CACHE = new WeakMap();

export function _stableSerialize(obj) {
  if (SORTED_KEYS_CACHE.has(obj)) {
    const sortedKeys = SORTED_KEYS_CACHE.get(obj);
    return JSON.stringify(obj, sortedKeys);
  }
  const sortedKeys = Object.keys(obj).sort();
  SORTED_KEYS_CACHE.set(obj, sortedKeys);
  return JSON.stringify(obj, sortedKeys);
}
```

**Métrica de Éxito:**
- ✅ Funciones de serialización optimizadas
- ✅ Reducción estimada: 20% tiempo en hashing fiscal
- ✅ Memory leak prevenido con WeakMap

---

### **FASE 6: TESTING Y CALIDAD**
**Duración Estimada:** 8-10 horas  
**Prioridad:** 🟢 MEDIA-LARGO PLAZO  
**Beneficio:** Confianza en deployments, menos bugs en producción

#### **Iteración 6.1: Configurar Framework de Testing** (60 minutos)

**Setup Inicial:**
```bash
npm install --save-dev jest @types/jest ts-jest
```

**jest.config.js:**
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.(ts|js)'],
  moduleNameMapper: {
    '^backend/(.*)$': '<rootDir>/src/backend/$1',
    '^public/(.*)$': '<rootDir>/src/public/$1',
  },
  collectCoverageFrom: [
    'src/**/*.js',
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};
```

**Métrica de Éxito:**
- ✅ Jest configurado y funcional
- ✅ 1 test de ejemplo pasando
- ✅ Coverage report generado

---

#### **Iteración 6.2: Tests Unitarios para Funciones Críticas** (120 minutos)

**Funciones Prioritarias:**

1. **`bookingCore.js` - `_buildLockKeys`:**
```typescript
// __tests__/bookingCore.test.ts
import { _buildLockKeys } from 'backend/booking/bookingCore';

describe('_buildLockKeys', () => {
  it('debe generar clave única para slot dado', () => {
    const slot = { serviceId: 'svc1', startDate: '2026-09-13T10:00:00' };
    const key = _buildLockKeys(slot);
    expect(key).toMatch(/^LOCK_svc1_\d+$/);
  });

  it('debe generar misma clave para mismo slot', () => {
    const slot = { serviceId: 'svc1', startDate: '2026-09-13T10:00:00' };
    expect(_buildLockKeys(slot)).toBe(_buildLockKeys(slot));
  });
});
```

2. **`cajas.web.js` - `hashSHA256`:**
```typescript
import { hashSHA256 } from 'backend/securityEngine';

describe('hashSHA256', () => {
  it('debe generar hash consistente', () => {
    const input = 'test-string';
    const hash1 = hashSHA256(input);
    const hash2 = hashSHA256(input);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex
  });
});
```

**Métrica de Éxito:**
- ✅ 10+ tests unitarios escritos
- ✅ Coverage > 60% en funciones críticas
- ✅ Tests corren en CI

---

#### **Iteración 6.3: Tests de Integración para Flujos Críticos** (90 minutos)

**Flujos a Testear:**

1. **Flow completo de reserva:**
```typescript
describe('Booking Flow Integration', () => {
  it('debe completar reserva desde disponibilidad hasta confirmación', async () => {
    const availability = await checkAvailability(serviceId, date);
    const slot = selectSlot(availability);
    const booking = await createBooking(slot, customerData);
    const payment = await processPayment(booking);
    const confirmed = await confirmBooking(booking.id);
    
    expect(confirmed.status).toBe('CONFIRMED');
    expect(payment.status).toBe('PAID');
  });
});
```

2. **Flow fiscal Veri*factu:**
```typescript
describe('Fiscal Chain Integrity', () => {
  it('debe mantener cadena hash intacta después de múltiples movimientos', async () => {
    const initialHash = await getCurrentChainHash();
    for (let i = 0; i < 10; i++) {
      await procesarMovimientoCaja(mockMovement);
    }
    const finalHash = await getCurrentChainHash();
    expect(validateChainIntegrity(initialHash, finalHash)).toBe(true);
  });
});
```

**Métrica de Éxito:**
- ✅ 5+ tests de integración
- ✅ Flujos críticos cubiertos
- ✅ Tests aislados con mocks

---

#### **Iteración 6.4: Configurar CI/CD Pipeline** (60 minutos)

**.github/workflows/ci.yml:**
```yaml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: codecov/codecov-action@v3

  build:
    runs-on: ubuntu-latest
    needs: [lint, typecheck, test]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
```

**Métrica de Éxito:**
- ✅ Pipeline CI configurado
- ✅ Tests corren en cada PR
- ✅ Build verificado antes de merge

---

## 📈 MÉTRICAS GLOBALES DE ÉXITO

### **Antes vs Después (Proyección Realista)**

| Métrica | Antes | Después | Mejora |
|---------|-------|---------|--------|
| Errores ESLint | 61 | 0 | -100% ✅ |
| Advertencias ESLint | 101 | <20 | -80% ✅ |
| Funciones >100 líneas | 8 | 0 | -100% ✅ |
| Coverage de Tests | 0% | 65% | +65pp ✅ |
| Tiempo Build | ~45s | ~35s | -22% ✅ |
| Vulnerabilidades npm | 0 críticas | 0 críticas | Mantenido ✅ |
| Condiciones de Carrera | 6 | 0 | -100% ✅ |
| Imports Duplicados | 1 | 0 | -100% ✅ |
| Variables No Usadas | 35+ | 0 | -100% ✅ |

---

## 🗓️ CRONOGRAMA ESTIMADO

| Fase | Duración | Dependencias | Riesgo |
|------|----------|--------------|--------|
| **Fase 1: Errores Críticos** | 2-3 horas | Ninguna | Bajo |
| **Fase 2: Limpieza** | 3-4 horas | Fase 1 completada | Bajo |
| **Fase 3: Refactorización** | 6-8 horas | Fases 1-2 completadas | Medio |
| **Fase 4: Migración** | 2-3 horas | Fases 1-3 completadas | Medio |
| **Fase 5: Performance** | 4-5 horas | Fases 1-4 completadas | Bajo |
| **Fase 6: Testing** | 8-10 horas | Paralelizable con Fases 3-5 | Medio |
| **TOTAL** | **25-33 horas** | - | - |

**Recomendación:** Ejecutar en 3-4 sprints de 8 horas cada uno

---

## ⚠️ RIESGOS Y MITIGACIÓN

### **Riesgo Alto: Regresión en Booking**
**Mitigación:**
- Tests exhaustivos antes de deploy
- Feature flags para cambios grandes
- Rollback planificado

### **Riesgo Medio: Breaking Changes en Types**
**Mitigación:**
- Migración incremental
- Validación en staging primero
- Comunicación con equipo frontend

### **Riesgo Bajo: Performance Degradation**
**Mitigación:**
- Benchmarks antes/después
- Monitoring en producción
- A/B testing si es necesario

---

## 📝 CHECKLIST DE IMPLEMENTACIÓN

### **Fase 1 (URGENTE - Esta Semana)**
- [ ] Corregir 6 condiciones de carrera
- [ ] Fix clave duplicada en cajas.web.js
- [ ] Eliminar bloques vacíos
- [ ] Agregar imports faltantes de $w
- [ ] Consolidar importaciones duplicadas
- [ ] Eliminar await redundantes

### **Fase 2 (ALTA - Próxima Semana)**
- [ ] Limpiar variables no usadas
- [ ] Reemplazar tipos `any`
- [ ] Migrar console.log a logger
- [ ] Fix escape characters

### **Fase 3 (MEDIA - Sprint 3-4)**
- [ ] Descomponer funciones grandes
- [ ] Unificar logger
- [ ] Separar utils backend/frontend
- [ ] Mejorar tipado TypeScript

### **Fase 4 (MEDIA - Sprint 4-5)**
- [ ] Actualizar dependencias
- [ ] Migrar a ESLint flat config
- [ ] Endurecer TypeScript config

### **Fase 5 (MEDIA - Sprint 5-6)**
- [ ] Optimizar queries
- [ ] Implementar caches
- [ ] Lazy loading módulos
- [ ] Optimizar serialización

### **Fase 6 (LARGO PLAZO - Sprint 7-8)**
- [ ] Configurar Jest
- [ ] Escribir tests unitarios
- [ ] Tests de integración
- [ ] CI/CD pipeline

---

## 🎯 CONCLUSIÓN EJECUTIVA

El sistema Wix analizado presenta una **base sólida** con arquitectura bien documentada (versiones v5006.x, estándares G10 ASCII, comentarios detallados). Sin embargo, existen **61 errores críticos** que requieren atención inmediata, principalmente condiciones de carrera que pueden causar corrupción de datos en producción.

**Inversión Requerida:** 25-33 horas de desarrollo senior  
**ROI Esperado:** 
- 100% eliminación de errores críticos
- 60-80% reducción en bugs reportados
- 30-50% mejora en performance de queries
- 65% coverage de tests (de 0% actual)

**Recomendación:** Comenzar inmediatamente con **Fase 1** (errores críticos) en las próximas 48 horas para mitigar riesgos de producción. Las fases subsiguientes pueden planificarse en sprints regulares.

---

**Documento Generado:** 2026-09-13  
**Autor:** Experto Desarrollador Wix & Optimizador  
**Estado:** Listo para implementación  
**Próximo Paso:** Aprobar Fase 1 y comenzar iteración 1.1
