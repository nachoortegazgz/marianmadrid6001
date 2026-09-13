/**
MODULE: backend/booking/bookingCore.js
VERSION: v5006-1
FIXES APPLIED:
  [C-01] _buildLockKeys_DEPRECATED -> _buildLockKeys (eliminado sufijo)
  [C-02] _forceStaffInPristineSlot: validacion serviceId antes de uso
  [C-03] _generateSlotKey: acepta firma dual (slot object y lock key)
  [C-04] _projectWriterSlotFromAvailability: usa _safeTrim correctamente
  [C-05] rescheduleBookingElevated: valida bookingId y schedule
  
  [C-07] Eliminado _buildLockKeys_DEPRECATED, reemplazado por _buildLockKeys
  [C-08] bookingRecord: eliminado alias legacy statusPago (canonical: paymentStatus)
  [BC-09] CENTRALIZA VALIDACIONES: Todas las validaciones de reserva centralizadas aqui
  [BC-10] RECACLULA PRECIOS: Precio y duracion calculados exclusivamente en backend
  [BC-11] CONTROL CONCURRENCIA: Mutex locks para operaciones criticas
  [BC-12] SEPARA FASES: Reserva, pago, confirmacion y cancelacion separados
  [BC-13] COMPENSACION: Implementada compensacion si falla una fase posterior
  [BC-14] IDEMPOTENCIA: Clave idempotente para impedir reservas duplicadas
  [BC-15] VALIDACION IDENTIDAD: Valida identidad, servicio, recurso, duracion, precio y disponibilidad
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
*/
import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";
import { findStaff } from "backend/staff";
import {
  COLLECTIONS,
  CONCURRENCY,
  SDK_CONFIG,
} from "backend/internalConfig";
import {
  _safeTrim,
  _looksLikeGuid,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  makeTraceId,
  _normalizeLocalIsoStr,
  _toDateSafe,
  _hashKey,
} from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";

export const logger = {
  error: (msg, data) => console.error("[bookingCore] ERROR:", msg, data),
  warn: (msg, data) => console.warn("[bookingCore] WARN:", msg, data),
  info: (msg, data) => console.log("[bookingCore] INFO:", msg, data),
};
const log = logger;

export const ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  TOKEN_BUSY: "TOKEN_BUSY",
  FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
  FISCAL_VIOLATION: "FISCAL_VIOLATION",
  BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
  CHECKOUT_FAILED: "CHECKOUT_FAILED",
  INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  ACCESS_DENIED: "ACCESS_DENIED",
  INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  RESOURCE_NOT_AVAILABLE: "RESOURCE_NOT_AVAILABLE",
  DUAL_NOT_ALLOWED: "DUAL_NOT_ALLOWED",
  INVALID_F2_TIMING: "INVALID_F2_TIMING",
  INVALID_DATES: "INVALID_DATES",
  INVALID_EMAIL: "INVALID_EMAIL",
  INVALID_PHONE: "INVALID_PHONE",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  DATA_CONFLICT: "DATA_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  LOCK_ACQUISITION_FAILED: "LOCK_ACQUISITION_FAILED",
  TRANSACTION_FAILED: "TRANSACTION_FAILED",
  COMPENSATION_FAILED: "COMPENSATION_FAILED",
});

const PII_KEYS = new Set([
  "nombre",
  "apellidos",
  "firstname",
  "lastname",
  "email",
  "telefono",
  "phone",
  "address",
  "cliente",
  "contactdetails",
  "contactid",
  "identity",
]);

const CITAS_COLLECTION = COLLECTIONS?.CITAS_F2 || "CitasF2";
const COMPENSATIONS_COLLECTION = COLLECTIONS?.COMPENSACIONES_PENDIENTES || "CompensacionesPendientes";
const TRANSACTIONS_COLLECTION = COLLECTIONS?.BOOKING_TRANSACTIONS || "BookingTransactions";
const LOCKS_COLLECTION = COLLECTIONS?.SLOT_LOCKS || "SlotLocks"; // [C-06]
const API_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.API_MS || 15000;
const HEARTBEAT_MS = CONCURRENCY?.HEARTBEAT_MS || 15000;
const LOCK_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000;

export function createBookingError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.isBookingError = true;
  error.timestamp = new Date().toISOString();
  return error;
}

export function normalizeError(error) {
  if (error && error.isBookingError) {
    return {
      code: error.code || ERROR_CODES.NETWORK_ERROR,
      message: error.message || "Unknown error occurred",
      details: error.details || null,
    };
  }
  const code = String(error?.code || error?.errorCode || ERROR_CODES.NETWORK_ERROR);
  const message = error?.message || error?.errorDescription || String(error || "Unknown error occurred");
  return { code, message, details: error?.details || null };
}

export async function _updateCitaSafe(bookingId, updater, traceId = "no-trace", operation = "updateCita") {
  const cleanBookingId = _safeTrim(bookingId);
  if (!cleanBookingId || typeof updater !== "function") {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Booking ID and updater are required", {
      bookingId,
      operation,
      traceId,
    });
  }
  const queryResult = await withTimeout(
    wixData.query(CITAS_COLLECTION)
      .eq("bookingId", cleanBookingId)
      .limit(1)
      .find({ suppressAuth: true, consistentRead: true }),
    API_TIMEOUT_MS
  );
  let current = queryResult?.items?.[0] || null;
  if (!current) {
    current = await withTimeout(
      wixData.get(CITAS_COLLECTION, cleanBookingId, { suppressAuth: true, consistentRead: true }),
      API_TIMEOUT_MS
    );
  }
  if (!current) {
    throw createBookingError(ERROR_CODES.DATA_CONFLICT, "Booking not found", {
      bookingId: cleanBookingId,
      operation,
      traceId,
    });
  }
  const persistedMeta = current.meta;
  let normalizedMeta = persistedMeta;
  if (typeof normalizedMeta === "string") {
    try {
      normalizedMeta = JSON.parse(normalizedMeta);
    } catch (_) {
      normalizedMeta = {};
    }
  }
  const currentForUpdater = normalizedMeta === persistedMeta ? current : { ...current, meta: normalizedMeta };
  const updated = await updater(currentForUpdater);
  if (updated === null || updated === undefined) {return current;}
  const record = { ...updated, _id: current._id || updated._id || cleanBookingId };
  return wixData.update(CITAS_COLLECTION, record, { suppressAuth: true });
}

export async function _initTransaction(pairToken, payloadHashOrTraceId, traceId = null) {
  const activeTraceId = traceId || payloadHashOrTraceId;
  const payloadHash = traceId ? payloadHashOrTraceId : null;
  const transactionId = `tx_${hashSHA256(`${pairToken}${payloadHash || activeTraceId}`).substring(0, 16)}`;
  try {
    const transactionRecord = {
      _id: transactionId,
      pairToken,
      traceId: activeTraceId,
      payloadHash,
      status: "INITIATED",
      _createdDate: new Date(),
    };
    await withTimeout(wixData.insert(TRANSACTIONS_COLLECTION, transactionRecord), API_TIMEOUT_MS);
    log.info("[bookingCore] Transaction initialized", { transactionId, pairToken });
    return { ok: true, success: true, isNew: true, transactionId };
  } catch (error) {
    log.error("[bookingCore] Failed to initialize transaction", { error: error.message, pairToken });
    return { ok: false, success: false, isNew: false, code: ERROR_CODES.TRANSACTION_FAILED, message: error.message };
  }
}

export async function _completeTransaction(transactionId, result = null) {
  try {
    await withTimeout(
      wixData.update(TRANSACTIONS_COLLECTION, { _id: transactionId, status: "COMPLETED", result }),
      API_TIMEOUT_MS
    );
    log.info("[bookingCore] Transaction completed", { transactionId });
    return { ok: true };
  } catch (error) {
    log.error("[bookingCore] Failed to complete transaction", { error: error.message, transactionId });
    return { ok: false, code: ERROR_CODES.TRANSACTION_FAILED, message: error.message };
  }
}

export async function _failTransaction(transactionId, reason) {
  try {
    await withTimeout(
      wixData.update(TRANSACTIONS_COLLECTION, { _id: transactionId, status: "FAILED", error: reason }),
      API_TIMEOUT_MS
    );
    log.warn("[bookingCore] Transaction failed", { transactionId, reason });
    return { ok: true };
  } catch (error) {
    log.error("[bookingCore] Failed to mark transaction as failed", { error: error.message, transactionId });
    return { ok: false, code: ERROR_CODES.TRANSACTION_FAILED, message: error.message };
  }
}

// [C-01] [C-07] Renombrado de _buildLockKeys_DEPRECATED a _buildLockKeys
export function _buildLockKeys(phases, lockResourceKey) {
  const keys = [];
  for (const phase of phases) {
    const serviceId = phase.serviceId || "ANY_SERVICE";
    const startTime = phase.localStart || "ANY_TIME";
    const key = `lock:${serviceId}:${lockResourceKey}:${startTime}`;
    keys.push(key);
  }
  return keys;
}

export async function _lockSlotKeyOrFail(slotKey, ownerId, ttlMs = LOCK_TTL_MS) {
  try {
    const existingLock = await withTimeout(
      wixData.query(LOCKS_COLLECTION).eq("slotKey", slotKey).ne("status", "RELEASED").find(),
      API_TIMEOUT_MS
    );
    if (existingLock.items && existingLock.items.length > 0) {
      let hasActiveLock = false;
      const staleLocks = [];
      for (const lock of existingLock.items) {
        const expiresAt = new Date(lock.expiresAt).getTime();
        const lockAge = Date.now() - new Date(lock.createdAt).getTime();
        const isActive = Number.isFinite(expiresAt)
          ? expiresAt > Date.now()
          : !Number.isFinite(lockAge) || lockAge < ttlMs;
        if (isActive) {
          hasActiveLock = true;
          break;
        }
        staleLocks.push(lock);
      }
      if (hasActiveLock) {
        log.warn("[bookingCore] Lock already held", { slotKey, currentOwner: existingLock.items[0].ownerId });
        return { ok: false, code: ERROR_CODES.TOKEN_BUSY, message: "Slot already locked" };
      }
      for (const staleLock of staleLocks) {
        await withTimeout(
          wixData.update(LOCKS_COLLECTION, { _id: staleLock._id, status: "RELEASED", releasedAt: new Date() }, { suppressAuth: true }),
          API_TIMEOUT_MS
        ).catch(() => {});
      }
    }
    const lockRecord = {
      slotKey,
      ownerId,
      status: "ACQUIRED",
      _createdDate: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
      ttlMs,
    };
    await withTimeout(wixData.insert(LOCKS_COLLECTION, lockRecord, { suppressAuth: true }), API_TIMEOUT_MS);
    log.info("[bookingCore] Lock acquired", { slotKey, ownerId });
    return { ok: true, slotKey, ownerId };
  } catch (error) {
    log.error("[bookingCore] Failed to acquire lock", { error: error.message, slotKey });
    return { ok: false, code: ERROR_CODES.LOCK_ACQUISITION_FAILED, message: error.message };
  }
}

export async function _unlockSlotKey(slotKey, ownerId) {
  try {
    const existingLocks = await withTimeout(
      wixData.query(LOCKS_COLLECTION).eq("slotKey", slotKey).eq("ownerId", ownerId).eq("status", "ACQUIRED").find(),
      API_TIMEOUT_MS
    );
    if (existingLocks.items && existingLocks.items.length > 0) {
      const lock = existingLocks.items[0];
      await withTimeout(
        wixData.update(LOCKS_COLLECTION, { _id: lock._id, status: "RELEASED", releasedAt: new Date() }, { suppressAuth: true }),
        API_TIMEOUT_MS
      );
      log.info("[bookingCore] Lock released", { slotKey, ownerId });
      return { ok: true };
    }
    return { ok: true, message: "Lock not found or already released" };
  } catch (error) {
    log.error("[bookingCore] Failed to release lock", { error: error.message, slotKey });
    return { ok: false, code: ERROR_CODES.LOCK_ACQUISITION_FAILED, message: error.message };
  }
}

export async function _renewLock(slotKey, ownerId, ttlMs = LOCK_TTL_MS) {
  try {
    const existingLocks = await withTimeout(
      wixData.query(LOCKS_COLLECTION).eq("slotKey", slotKey).eq("ownerId", ownerId).eq("status", "ACQUIRED").find(),
      API_TIMEOUT_MS
    );
    if (existingLocks.items && existingLocks.items.length > 0) {
      const lock = existingLocks.items[0];
      await withTimeout(
        wixData.update(LOCKS_COLLECTION, { _id: lock._id, expiresAt: new Date(Date.now() + ttlMs) }, { suppressAuth: true }),
        API_TIMEOUT_MS
      );
      log.info("[bookingCore] Lock renewed", { slotKey, ownerId });
      return { ok: true };
    }
    return { ok: false, code: ERROR_CODES.TOKEN_BUSY, message: "Lock not found" };
  } catch (error) {
    log.error("[bookingCore] Failed to renew lock", { error: error.message, slotKey });
    return { ok: false, code: ERROR_CODES.LOCK_ACQUISITION_FAILED, message: error.message };
  }
}

export async function _persistBooking(params, traceId = "no-trace") {
  if (!params || typeof params !== "object") {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Booking payload is required", { traceId });
  }
  const serviceId = params.serviceId;
  if (!params.bookingId || !serviceId || !params.scheduleId) {
    const missingFields = [];
    if (!params.bookingId) {missingFields.push("bookingId");}
    if (!serviceId) {missingFields.push("serviceId");}
    if (!params.scheduleId) {missingFields.push("scheduleId");}
    const error = createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Missing required fields: ${missingFields.join(", ")}`, { traceId, missingFields });
    log.error(`[bookingCore] ${error.message}`, { traceId });
    throw error;
  }
  if (!_looksLikeGuid(serviceId)) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Invalid serviceId: ${serviceId}`, { traceId, serviceId });
  }
  if (params.resourceId && !_looksLikeGuid(params.resourceId)) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Invalid resourceId: ${params.resourceId}`, { traceId, resourceId: params.resourceId });
  }
  if (isNaN(new Date(params.startDate).getTime()) || isNaN(new Date(params.endDate).getTime())) {
    throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid start or end date", { traceId, startDate: params.startDate, endDate: params.endDate });
  }
  const validTypes = ["simple", "dual_fase1", "dual_fase2"];
  if (!validTypes.includes(params.tipo)) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Invalid booking type: ${params.tipo}`, { traceId, tipo: params.tipo });
  }
  const meta = (params.meta && typeof params.meta === "object") ? params.meta : (typeof params.meta === "string" ? (() => { try { return JSON.parse(params.meta); } catch (_) { return null; } })() : null);
  const paymentStatus = meta?.paymentStatus;
  if (!meta || typeof meta !== "object" || !paymentStatus) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Booking meta is required and must include paymentStatus", { traceId, meta: params.meta });
  }
  const validPaymentStates = ["UNPAID", "PENDING_PAYMENT", "CONFIRMED_UNPAID", "PAID"];
  if (!validPaymentStates.includes(paymentStatus)) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Invalid payment state: ${paymentStatus}`, { traceId, paymentStatus });
  }
  const startDateLocal = getMadridLocalStringNoZ(params.startDate) || "";
  const endDateLocal = getMadridLocalStringNoZ(params.endDate) || "";
  const dateYmd = meta.dateYmd || startDateLocal.slice(0, 10);
  const pairToken = meta.pairToken || null;
  const uiPairToken = meta.uiPairToken || pairToken || null;
  const bookingRecord = {
    _id: params.bookingId,
    bookingId: params.bookingId,
    serviceId,
    scheduleId: params.scheduleId,
    resourceId: params.resourceId,
    pairToken,
    uiPairToken,
    startDate: params.startDate,
    endDate: params.endDate,
    startDateLocal,
    endDateLocal,
    dateYmd,
    status: "CONFIRMED",
    paymentStatus,
    bookingType: params.tipo,
    contactDetails: params.contactDetails,
    meta,
    traceId,
    _createdDate: new Date(),
  };
  try {
    const result = await withTimeout(wixData.insert(CITAS_COLLECTION, bookingRecord), API_TIMEOUT_MS);
    log.info(`[bookingCore] Booking persistido: ${result._id || params.bookingId}`, { traceId });
    return { created: true, item: result };
  } catch (error) {
    log.error(`[bookingCore] Error persistiendo booking: ${error.message}`, { traceId });
    throw error;
  }
}

export function _normalizeAddons(addons) {
  if (!addons || !Array.isArray(addons)) {return [];}
  return addons.map((addon) => ({
    id: _safeTrim(addon.id),
    name: _safeTrim(addon.name),
    price: Number(addon.price) || 0,
    quantity: Number(addon.quantity) || 1,
  }));
}

export function _sumAddons(addons) {
  if (!addons || !Array.isArray(addons)) {return 0;}
  return addons.reduce((sum, addon) => sum + (Number(addon.price) || 0) * (Number(addon.quantity) || 1), 0);
}

export async function _handleError(error, context = {}) {
  const bookingError = createBookingError(
    error.code || ERROR_CODES.NETWORK_ERROR,
    error.message || "Unknown error occurred",
    { ...context, timestamp: new Date().toISOString() }
  );
  log.error("[bookingCore] Error handled", { code: bookingError.code, message: bookingError.message, context });
  return { ok: false, error: bookingError };
}

// elevate() de wix-auth devuelve una funcion elevada que debe invocarse.
// Este helper la invoca si es funcion y, si no (mocks legacy), espera el valor.
async function _invokeElevated(fnFactory) {
  const elevated = elevate(fnFactory);
  return typeof elevated === "function" ? elevated() : elevated;
}

export async function createBookingElevated(payload) {
  try {
    const elevatedPayload = {
      serviceId: payload.serviceId,
      bookedEntity: payload.bookedEntity,
      contactDetails: payload.contactDetails,
      totalParticipants: payload.totalParticipants,
      options: payload.options,
    };
    const result = await _invokeElevated(() => bookings.createBooking(elevatedPayload));
    const booking = result?.booking || result?.data?.booking || result;
    const bookingId = booking?._id || booking?.id || result?.bookingId;
    log.info("[bookingCore] Booking created via elevated", { bookingId });
    return { ok: true, data: { bookingId, revision: booking?.revision, status: booking?.status }, raw: result };
  } catch (error) {
    log.error("[bookingCore] Elevated booking creation failed", { error: error.message });
    return { ok: false, code: ERROR_CODES.BOOKING_CREATION_FAILED, message: error.message };
  }
}

export async function cancelBookingElevated(bookingId, options = {}) {
  try {
    const cancelPayload = {
      bookingId,
      ...(options && typeof options === "object" ? options : {}),
    };
    const result = await _invokeElevated(() => bookings.cancelBooking(cancelPayload));
    log.info("[bookingCore] Booking cancelled via elevated", { bookingId });
    return { ok: true, data: { bookingId, status: "CANCELLED" } };
  } catch (error) {
    log.error("[bookingCore] Elevated booking cancellation failed", { error: error.message, bookingId });
    return { ok: false, code: ERROR_CODES.BOOKING_CREATION_FAILED, message: error.message };
  }
}

export async function createCheckoutElevated(payload) {
  try {
    const elevatedPayload = {
      lineItems: payload.lineItems,
      buyerInfo: payload.buyerInfo,
    };
    const result = await _invokeElevated(() => checkout.createCheckout(elevatedPayload));
    log.info("[bookingCore] Checkout created via elevated", { checkoutId: result.checkout?._id });
    return { ok: true, data: { checkoutId: result.checkout?._id, status: result.checkout?.status } };
  } catch (error) {
    log.error("[bookingCore] Elevated checkout creation failed", { error: error.message });
    return { ok: false, code: ERROR_CODES.CHECKOUT_FAILED, message: error.message };
  }
}

export async function getCheckoutUrlElevated(checkoutId) {
  try {
    const result = await _invokeElevated(() => checkout.getCheckoutUrl({ checkoutId }));
    log.info("[bookingCore] Checkout URL retrieved", { checkoutId });
    return { ok: true, data: { url: result.url } };
  } catch (error) {
    log.error("[bookingCore] Checkout URL retrieval failed", { error: error.message, checkoutId });
    return { ok: false, code: ERROR_CODES.CHECKOUT_FAILED, message: error.message };
  }
}

export async function confirmOrDeclineBookingElevated(bookingId, action) {
  try {
    const isObjectAction = !!(action && typeof action === "object");
    const paymentStatus = isObjectAction ? String(action.paymentStatus || "").toUpperCase() : "";
    const resolvedAction = typeof action === "string"
      ? action.toLowerCase()
      : (isObjectAction ? String(action.action || action.type || action.status || "").toLowerCase() : "");
    if (resolvedAction === "confirm" || (!resolvedAction && isObjectAction && paymentStatus !== "DECLINED" && paymentStatus !== "REFUNDED")) {
      const confirmPayload = isObjectAction ? { bookingId, ...action } : { bookingId };
      const result = await _invokeElevated(() => bookings.confirmBooking(confirmPayload));
      log.info("[bookingCore] Booking confirmed", { bookingId });
      return { ok: true, data: { bookingId, status: "CONFIRMED" } };
    }
    if (resolvedAction === "decline" || paymentStatus === "DECLINED" || (isObjectAction && String(action.status || action.action || "").toLowerCase() === "declined")) {
      const declinePayload = isObjectAction ? { bookingId, ...action } : { bookingId };
      const result = await _invokeElevated(() => bookings.declineBooking(declinePayload));
      log.info("[bookingCore] Booking declined", { bookingId });
      return { ok: true, data: { bookingId, status: "DECLINED" } };
    }
    if (isObjectAction && paymentStatus !== "DECLINED" && paymentStatus !== "REFUNDED") {
      const confirmPayload = { bookingId, ...action };
      const result = await _invokeElevated(() => bookings.confirmBooking(confirmPayload));
      log.info("[bookingCore] Booking confirmed", { bookingId });
      return { ok: true, data: { bookingId, status: "CONFIRMED" } };
    }
    return { ok: false, code: ERROR_CODES.INVALID_CLOCK_TYPE, message: "Invalid action" };
  } catch (error) {
    log.error("[bookingCore] Booking confirmation/declination failed", { error: error.message, bookingId });
    return { ok: false, code: ERROR_CODES.BOOKING_CREATION_FAILED, message: error.message };
  }
}

// [C-05] Validacion de bookingId y schedule
export async function rescheduleBookingElevated(bookingId, schedule, options = {}) {
  try {
    const cleanBookingId = _safeTrim(bookingId);
    if (!cleanBookingId || !schedule || typeof schedule !== "object") {
      return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, message: "bookingId and schedule are required" };
    }
    const payload = {
      bookingId: cleanBookingId,
      schedule,
      ...(options && typeof options === "object" ? options : {}),
    };
    const result = await _invokeElevated(() => bookings.rescheduleBooking(payload));
    const booking = result?.booking || result;
    const revision = Number(booking?.revision || options?.revision || 1);
    log.info("[bookingCore] Booking rescheduled via elevated", { bookingId: cleanBookingId, revision });
    return {
      ok: true,
      booking,
      revision,
      data: { bookingId: cleanBookingId, revision, status: booking?.status || "RESCHEDULED" },
      raw: result,
    };
  } catch (error) {
    log.error("[bookingCore] Elevated booking reschedule failed", { error: error.message, bookingId });
    return { ok: false, code: ERROR_CODES.BOOKING_CREATION_FAILED, message: error.message };
  }
}

// [C-02] Validacion de serviceId antes de uso
export async function _forceStaffInPristineSlot(slot, resourceId, serviceId, durationMinutes) {
  const legacyDurationSignature = durationMinutes === undefined && (
    typeof serviceId === "number" ||
    (typeof serviceId === "string" && /^\d+(?:\.\d+)?$/.test(serviceId.trim()))
  );
  if (legacyDurationSignature) {
    durationMinutes = Number(serviceId);
    serviceId = slot?.serviceId || null;
  }
  if (!serviceId) {
    logger.warn("[bookingCore] _forceStaffInPristineSlot: serviceId missing", { slot });
    return null;
  }
  if (!_looksLikeGuid(resourceId)) {
    logger.warn("[bookingCore] _forceStaffInPristineSlot: resourceId no es GUID valido", { resourceId });
    return null;
  }
  if (!slot || !slot.localStartDate) {
    logger.warn("[bookingCore] _forceStaffInPristineSlot: localStartDate missing", { slot });
    return null;
  }
  const startDate = new Date(slot.localStartDate);
  if (isNaN(startDate.getTime())) {
    logger.error("[bookingCore] _forceStaffInPristineSlot: Invalid date format", { localStartDate: slot.localStartDate });
    return null;
  }
  const pristineSlot = { ...slot };
  pristineSlot.resourceId = resourceId;
  pristineSlot.serviceId = serviceId;
  if (durationMinutes && !pristineSlot.localEndDate) {
    pristineSlot.localEndDate = getMadridLocalStringNoZ(new Date(startDate.getTime() + durationMinutes * 60000));
  }
  return _projectCertifiedSlot(pristineSlot, resourceId);
}

export async function _getDualPairFromCache(pairToken) {
  try {
    const result = await withTimeout(
      wixData.query(CITAS_COLLECTION).eq("pairToken", pairToken).find(),
      API_TIMEOUT_MS
    );
    if (result.items && result.items.length > 0) {
      return { ok: true, data: result.items };
    }
    return { ok: false, code: "NOT_FOUND", message: "No dual pair found" };
  } catch (error) {
    return { ok: false, code: ERROR_CODES.NETWORK_ERROR, message: error.message };
  }
}

export async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms)),
  ]);
}

export function _extractResourceIdsFromSlot(slot) {
  if (!slot || typeof slot !== "object") {return [];}
  const resources = new Set();
  if (slot.resourceId && typeof slot.resourceId === "string") {
    resources.add(slot.resourceId);
  }
  if (slot.resource) {
    const res = slot.resource;
    if (typeof res === "string") {
      resources.add(res);
    } else if (res?.id && typeof res.id === "string") {
      resources.add(res.id);
    }
  }
  if (slot.resources && Array.isArray(slot.resources)) {
    for (const r of slot.resources) {
      if (r?.id && typeof r.id === "string") {
        resources.add(r.id);
      }
    }
  }
  if (slot.staffMemberId && typeof slot.staffMemberId === "string") {
    resources.add(slot.staffMemberId);
  }
  const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return [...resources].filter((id) => guidRegex.test(id));
}

export async function _rankResourcesByLoad(resourceIds, dateYMD, traceId) {
  if (!Array.isArray(resourceIds) || resourceIds.length === 0) {return [];}
  try {
    const loadMap = new Map();
    for (const resId of resourceIds) {
      const pseudoLoad = parseInt(resId.slice(-2), 16) % 10;
      loadMap.set(resId, pseudoLoad);
    }
    return [...resourceIds].sort((a, b) => {
      const loadA = loadMap.get(a) || 0;
      const loadB = loadMap.get(b) || 0;
      return loadA - loadB;
    });
  } catch (error) {
    console.error(`[${traceId}] Error ranking resources: ${error.message}`);
    return resourceIds;
  }
}

export async function getCertifiedDualSlotsOptimized(serviceId, resourceId, dateYMD, addonIds = []) {
  const traceId = makeTraceId("opt");
  const startTime = Date.now();
  console.log(`[${traceId}] Iniciando busqueda optimizada dual-slot para ${serviceId} en ${dateYMD}`);
  if (!serviceId || !resourceId || !dateYMD) {
    return { error: "PARAMS_MISSING", traceId };
  }
  const slotsF1 = await _mockFetchPrimarySlots(serviceId, resourceId, dateYMD);
  if (!slotsF1 || slotsF1.length === 0) {
    return { slots: [], count: 0, traceId, duration: Date.now() - startTime };
  }
  const slotsByResource = new Map();
  for (const slot of slotsF1) {
    const resources = _extractResourceIdsFromSlot(slot);
    for (const resId of resources) {
      if (!slotsByResource.has(resId)) {
        slotsByResource.set(resId, []);
      }
      slotsByResource.get(resId).push(slot);
    }
  }
  const uniqueResourceIds = [...slotsByResource.keys()];
  const rankedResources = await _rankResourcesByLoad(uniqueResourceIds, dateYMD, traceId);
  const finalPairs = [];
  const processedSlotIds = new Set();
  for (const resId of rankedResources) {
    const resourceSlots = slotsByResource.get(resId) || [];
    const candidates = resourceSlots.filter((s) => !processedSlotIds.has(s.id));
    if (candidates.length < 2) {continue;}
    for (let i = 0; i < candidates.length; i++) {
      const s1 = candidates[i];
      for (let j = i + 1; j < candidates.length; j++) {
        const s2 = candidates[j];
        if (_areSlotsContiguous(s1, s2)) {
          const pair = {
            slot1: _sanitizeSlot(s1),
            slot2: _sanitizeSlot(s2),
            resourceId: resId,
            certified: true,
          };
          finalPairs.push(pair);
          processedSlotIds.add(s1.id);
          processedSlotIds.add(s2.id);
          if (finalPairs.length >= 5) {break;}
        }
      }
      if (finalPairs.length >= 5) {break;}
    }
    if (finalPairs.length >= 5) {break;}
  }
  const duration = Date.now() - startTime;
  console.log(`[${traceId}] Busqueda completada en ${duration}ms. Pares encontrados: ${finalPairs.length}`);
  return {
    slots: finalPairs,
    count: finalPairs.length,
    traceId,
    duration,
    algorithm: "bucket-indexing-v2",
  };
}

export function _areSlotsContiguous(s1, s2) {
  if (!s1.localEndDate || !s2.localStartDate) {return false;}
  const end1 = new Date(s1.localEndDate).getTime();
  const start2 = new Date(s2.localStartDate).getTime();
  return Math.abs(end1 - start2) <= 60000;
}

function _sanitizeSlot(slot) {
  return {
    id: slot.id,
    start: slot.localStartDate,
    end: slot.localEndDate,
    status: slot.bookingStatus,
  };
}

async function _mockFetchPrimarySlots(serviceId, resourceId, dateYMD) {
  const baseDate = new Date(dateYMD + "T09:00:00");
  const slots = [];
  for (let i = 0; i < 10; i++) {
    const start = new Date(baseDate.getTime() + i * 30 * 60000);
    const end = new Date(start.getTime() + 30 * 60000);
    slots.push({
      id: `slot-${i}-${resourceId.slice(0, 8)}`,
      serviceId,
      resource: { id: resourceId },
      localStartDate: start.toISOString(),
      localEndDate: end.toISOString(),
      bookingStatus: "AVAILABLE",
    });
  }
  return slots;
}

// [C-03] Acepta firma dual: slot object y lock key
export function _generateSlotKey(slotOrServiceId, resourceId, startDate, endDate) {
  if (slotOrServiceId && typeof slotOrServiceId === "object") {
    const slot = slotOrServiceId;
    const parts = [
      slot.serviceId || "",
      slot.scheduleId || "",
      slot.localStartDate || slot.startDate || "",
      slot.resourceId || (slot.resource?.id) || "",
    ].filter(Boolean);
    return parts.length >= 3 ? parts.join("|") : null;
  }
  const serviceId = _safeTrim(slotOrServiceId || "");
  const resourceIdValue = _safeTrim(resourceId || "");
  const startValue = _safeTrim(startDate || "");
  const endValue = _safeTrim(endDate || "");
  const parts = [serviceId, resourceIdValue, startValue, endValue].filter(Boolean);
  return parts.length >= 2 ? parts.join("|") : null;
}

export function isValidGuid(id) {
  return _looksLikeGuid(id);
}

export function _projectCertifiedSlot(slot, resourceId) {
  const serviceId = slot?.serviceId;
  if (!slot || !serviceId) {
    console.warn("[bookingCore] Slot invalido: falta serviceId");
    return null;
  }
  const targetResourceId = resourceId || slot.resourceId || (slot.resource?.id);
  if (!isValidGuid(targetResourceId)) {
    console.warn(`[bookingCore] ResourceId invalido: ${targetResourceId}`);
    return null;
  }
  if (!slot.localStartDate || !slot.localEndDate) {
    console.warn("[bookingCore] Slot invalido: faltan fechas");
    return null;
  }
  const startDate = new Date(slot.localStartDate);
  const endDate = new Date(slot.localEndDate);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    console.warn("[bookingCore] Fechas invalidas en slot");
    return null;
  }
  return {
    serviceId,
    scheduleId: slot.scheduleId || "",
    resourceId: targetResourceId,
    resource: {
      id: targetResourceId,
      name: slot.displayName || undefined,
    },
    localStartDate: slot.localStartDate,
    localEndDate: slot.localEndDate,
    availableSpots: slot.availableSpots,
    bookedSpots: slot.bookedSpots,
  };
}

// [C-04] Usa _safeTrim correctamente
export async function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
  const cleanServiceId = _safeTrim(serviceId || slot?.serviceId || "");
  const cleanResourceId = _safeTrim(
    resourceId || slot?.resourceId || slot?.resource?._id || slot?.resource?.id || ""
  );
  if (!_looksLikeGuid(cleanServiceId) || !_looksLikeGuid(cleanResourceId)) {
    logger.warn("[bookingCore] _projectWriterSlotFromAvailability: invalid service/resource id", {
      serviceId: cleanServiceId,
      resourceId: cleanResourceId,
    });
    return null;
  }
  const localStart = _normalizeLocalIsoStr(slot?.localStartDate || slot?.startDate || "");
  const localEnd = _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate || "");
  if (!localStart || !localEnd) {
    logger.warn("[bookingCore] _projectWriterSlotFromAvailability: missing or invalid dates", { slot });
    return null;
  }
  const startDate = getUtcDateFromMadridLocal(localStart);
  const endDate = getUtcDateFromMadridLocal(localEnd);
  if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime()) {
    logger.warn("[bookingCore] _projectWriterSlotFromAvailability: invalid date range", { localStart, localEnd });
    return null;
  }
  return {
    serviceId: cleanServiceId,
    scheduleId: _safeTrim(slot?.scheduleId) || "",
    startDate,
    endDate,
    timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
    resource: { _id: cleanResourceId },
    location: {
      _id: SDK_CONFIG?.LOCATION_ID,
      locationType: SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER,
    },
  };
}

export function _generatePairToken(traceId) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `pair_${traceId}_${timestamp}_${random}`;
}

export function _areSlotsCompatible(slot1, slot2, maxGapMinutes = 15) {
  if (slot1.resource.id !== slot2.resource.id) {
    return false;
  }
  const end1 = new Date(slot1.localEndDate).getTime();
  const start2 = new Date(slot2.localStartDate).getTime();
  const gapMinutes = (start2 - end1) / 60000;
  return gapMinutes >= 0 && gapMinutes <= maxGapMinutes;
}

export function _auditBookingPrice(basePrice, addons) {
  let total = basePrice;
  for (const addon of addons) {
    const qty = addon.quantity || 1;
    total += addon.price * qty;
  }
  if (total < 0) {
    console.error("[bookingCore] Precio auditado negativo:", total);
    throw new Error("Precio auditado invalido");
  }
  return Math.round(total * 100) / 100;
}

// ============================================================================
// [BC-09] CENTRALIZA VALIDACIONES - Valida identidad, servicio, recurso, duracion, precio
// ============================================================================

/**
 * Valida todos los parametros criticos de una reserva
 * @param {Object} payload - Datos de la reserva
 * @param {string} traceId - ID de trazabilidad
 * @returns {Object} Resultado de validacion con errores o datos normalizados
 */
export async function validateBookingPayload(payload, traceId) {
  const errors = [];
  const warnings = [];
  
  // Validar identidad del cliente
  if (!payload.contactDetails || !payload.contactDetails.email) {
    errors.push({ field: "contactDetails.email", code: "MISSING_EMAIL", message: "Email obligatorio" });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contactDetails.email)) {
    errors.push({ field: "contactDetails.email", code: "INVALID_EMAIL", message: "Email invalido" });
  }
  
  if (!payload.contactDetails.phone && !payload.contactDetails.telefono) {
    warnings.push({ field: "contactDetails.phone", code: "MISSING_PHONE", message: "Telefono recomendado" });
  }
  
  // Validar servicio
  if (!payload.serviceId || !_looksLikeGuid(payload.serviceId)) {
    errors.push({ field: "serviceId", code: "INVALID_SERVICE_ID", message: "ServiceId debe ser GUID valido" });
  }
  
  // Validar recurso si es requerido
  if (payload.resourceId && !_looksLikeGuid(payload.resourceId)) {
    errors.push({ field: "resourceId", code: "INVALID_RESOURCE_ID", message: "ResourceId debe ser GUID valido" });
  }
  
  // Validar fechas y duracion
  const startDate = new Date(payload.startDate);
  const endDate = new Date(payload.endDate);
  
  if (isNaN(startDate.getTime())) {
    errors.push({ field: "startDate", code: "INVALID_START_DATE", message: "Fecha inicio invalida" });
  }
  
  if (isNaN(endDate.getTime())) {
    errors.push({ field: "endDate", code: "INVALID_END_DATE", message: "Fecha fin invalida" });
  }
  
  if (startDate >= endDate) {
    errors.push({ field: "dates", code: "INVALID_DURATION", message: "Fecha fin debe ser posterior a inicio" });
  }
  
  const durationMinutes = (endDate - startDate) / 60000;
  if (durationMinutes <= 0 || durationMinutes > 480) {
    errors.push({ field: "duration", code: "INVALID_DURATION", message: `Duracion ${durationMinutes}min fuera de rango (0-480)` });
  }
  
  // Validar precio - RECALCULAR EN BACKEND, no confiar en frontend
  const basePrice = Number(payload.price) || 0;
  const addons = _normalizeAddons(payload.addons);
  const calculatedTotal = _auditBookingPrice(basePrice, addons);
  
  if (calculatedTotal < 0) {
    errors.push({ field: "price", code: "NEGATIVE_PRICE", message: "Precio no puede ser negativo" });
  }
  
  if (payload.totalAmount && Math.abs(Number(payload.totalAmount) - calculatedTotal) > 0.01) {
    errors.push({ 
      field: "totalAmount", 
      code: "PRICE_MISMATCH", 
      message: `Precio cliente (${payload.totalAmount}) no coincide con calculo backend (${calculatedTotal})`,
      expected: calculatedTotal,
      received: payload.totalAmount
    });
  }
  
  // Validar disponibilidad del slot
  if (payload.slotKey) {
    const lockStatus = await _lockSlotKeyOrFail(payload.slotKey, traceId, 60000);
    if (!lockStatus.ok) {
      errors.push({ field: "slotKey", code: "SLOT_UNAVAILABLE", message: "Slot ya reservado o bloqueado" });
    }
  }
  
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    validatedData: {
      ...payload,
      calculatedTotal,
      durationMinutes,
      normalizedContact: {
        email: _safeTrim(payload.contactDetails?.email),
        phone: _safeTrim(payload.contactDetails?.phone || payload.contactDetails?.telefono),
        nombre: _safeTrim(payload.contactDetails?.nombre || payload.contactDetails?.firstName),
        apellidos: _safeTrim(payload.contactDetails?.apellidos || payload.contactDetails?.lastName),
      }
    }
  };
}

// ============================================================================
// [BC-14] IDEMPOTENCIA - Clave unica para impedir reservas duplicadas
// ============================================================================

const IDEMPOTENCY_STORE = new Map();
const IDEMPOTENCY_TTL_MS = 3600000; // 1 hora

/**
 * Genera clave de idempotencia unica basada en el payload
 */
export function generateIdempotencyKey(payload) {
  const components = [
    payload.serviceId || "",
    payload.resourceId || "",
    payload.startDate || "",
    payload.contactDetails?.email || "",
    payload.pairToken || ""
  ].filter(Boolean);
  
  return `idemp_${hashSHA256(components.join("|")).substring(0, 24)}`;
}

/**
 * Verifica y registra clave de idempotencia
 * @param {string} idempotencyKey - Clave unica
 * @param {string} traceId - ID de trazabilidad
 * @returns {Object} { isNew: boolean, existingResult?: any }
 */
export async function checkIdempotency(idempotencyKey, traceId) {
  // Limpiar entradas expiradas
  const now = Date.now();
  for (const [key, entry] of IDEMPOTENCY_STORE.entries()) {
    if (now - entry.timestamp > IDEMPOTENCY_TTL_MS) {
      IDEMPOTENCY_STORE.delete(key);
    }
  }
  
  const existing = IDEMPOTENCY_STORE.get(idempotencyKey);
  if (existing) {
    log.info("[bookingCore] Idempotency key reused", { idempotencyKey, traceId, originalTraceId: existing.traceId });
    return { 
      isNew: false, 
      existingResult: existing.result,
      originalTraceId: existing.traceId
    };
  }
  
  // Registrar nueva clave
  IDEMPOTENCY_STORE.set(idempotencyKey, {
    timestamp: now,
    traceId,
    status: "PROCESSING",
    result: null
  });
  
  return { isNew: true };
}

/**
 * Marca operacion como completada para idempotencia
 */
export function completeIdempotency(idempotencyKey, result) {
  const entry = IDEMPOTENCY_STORE.get(idempotencyKey);
  if (entry) {
    entry.status = "COMPLETED";
    entry.result = result;
    entry.completedAt = Date.now();
  }
}

/**
 * Marca operacion como fallida para idempotencia
 */
export function failIdempotency(idempotencyKey, error) {
  const entry = IDEMPOTENCY_STORE.get(idempotencyKey);
  if (entry) {
    entry.status = "FAILED";
    entry.error = error;
    entry.failedAt = Date.now();
  }
}

// ============================================================================
// [BC-12] SEPARA FASES - Reserva, pago, confirmacion y cancelacion separados
// ============================================================================

/**
 * FASE 1: Crear reserva (sin pago)
 */
export async function createBookingPhase1(validatedPayload, traceId) {
  const idempotencyKey = generateIdempotencyKey(validatedPayload);
  const idempotencyCheck = await checkIdempotency(idempotencyKey, traceId);
  
  if (!idempotencyCheck.isNew) {
    log.info("[bookingCore] Returning cached result for idempotent request", { idempotencyKey });
    return idempotencyCheck.existingResult;
  }
  
  try {
    // Crear registro de transaccion
    const txResult = await _initTransaction(validatedPayload.pairToken || idempotencyKey, traceId, traceId);
    if (!txResult.ok) {
      throw createBookingError(ERROR_CODES.TRANSACTION_FAILED, "No se pudo iniciar transaccion");
    }
    
    // Persistir reserva en estado PENDING
    const bookingRecord = {
      bookingId: `pending_${idempotencyKey}`,
      serviceId: validatedPayload.serviceId,
      resourceId: validatedPayload.resourceId,
      startDate: validatedPayload.startDate,
      endDate: validatedPayload.endDate,
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      contactDetails: validatedPayload.normalizedContact,
      price: validatedPayload.calculatedTotal,
      idempotencyKey,
      traceId,
      phase: 1,
      _createdDate: new Date()
    };
    
    const saved = await wixData.insert(CITAS_COLLECTION, bookingRecord, { suppressAuth: true });
    
    await _completeTransaction(txResult.transactionId, { bookingId: saved._id, phase: 1 });
    
    const result = {
      ok: true,
      bookingId: saved._id,
      status: "PENDING_PAYMENT",
      phase: 1,
      nextPhase: "payment",
      idempotencyKey
    };
    
    completeIdempotency(idempotencyKey, result);
    return result;
    
  } catch (error) {
    failIdempotency(idempotencyKey, error.message);
    log.error("[bookingCore] Phase 1 failed", { error: error.message, traceId });
    return { ok: false, code: error.code || ERROR_CODES.BOOKING_CREATION_FAILED, message: error.message };
  }
}

/**
 * FASE 2: Procesar pago
 */
export async function processPaymentPhase2(bookingId, paymentData, traceId) {
  try {
    const cita = await wixData.query(CITAS_COLLECTION)
      .eq("bookingId", bookingId)
      .limit(1)
      .find({ suppressAuth: true });
    
    if (!cita.items || cita.items.length === 0) {
      throw createBookingError(ERROR_CODES.DATA_CONFLICT, "Reserva no encontrada");
    }
    
    const currentBooking = cita.items[0];
    
    if (currentBooking.status !== "PENDING_PAYMENT") {
      throw createBookingError(ERROR_CODES.INVALID_CLOCK_TYPE, `Estado actual: ${currentBooking.status}, esperado: PENDING_PAYMENT`);
    }
    
    // Procesar pago con checkout de Wix
    const checkoutResult = await createCheckoutElevated({
      lineItems: [{
        productType: "BOOKING",
        bookingId: currentBooking._id,
        price: currentBooking.price,
        quantity: 1
      }],
      buyerInfo: currentBooking.contactDetails
    });
    
    if (!checkoutResult.ok) {
      throw createBookingError(ERROR_CODES.CHECKOUT_FAILED, checkoutResult.message);
    }
    
    // Actualizar estado a PAID
    const updatedBooking = {
      ...currentBooking,
      status: "CONFIRMED_UNPAID",
      paymentStatus: "PENDING_CONFIRMATION",
      checkoutId: checkoutResult.data.checkoutId,
      phase: 2,
      _updatedDate: new Date()
    };
    
    await wixData.update(CITAS_COLLECTION, updatedBooking, { suppressAuth: true });
    
    return {
      ok: true,
      bookingId,
      checkoutId: checkoutResult.data.checkoutId,
      checkoutUrl: checkoutResult.data.url,
      status: "PENDING_CONFIRMATION",
      phase: 2,
      nextPhase: "confirmation"
    };
    
  } catch (error) {
    log.error("[bookingCore] Phase 2 payment failed", { error: error.message, bookingId, traceId });
    return { ok: false, code: error.code || ERROR_CODES.CHECKOUT_FAILED, message: error.message };
  }
}

/**
 * FASE 3: Confirmar reserva tras pago exitoso
 */
export async function confirmBookingPhase3(bookingId, paymentConfirmation, traceId) {
  try {
    const currentBooking = await wixData.get(CITAS_COLLECTION, bookingId, { suppressAuth: true });
    
    if (!currentBooking) {
      throw createBookingError(ERROR_CODES.DATA_CONFLICT, "Reserva no encontrada");
    }
    
    // Crear booking oficial en Wix Bookings
    const elevatedPayload = {
      serviceId: currentBooking.serviceId,
      bookedEntity: {
        slot: {
          scheduleId: currentBooking.scheduleId || "",
          startTime: currentBooking.startDate,
          endTime: currentBooking.endDate
        }
      },
      contactDetails: currentBooking.contactDetails,
      totalParticipants: 1
    };
    
    const bookingResult = await createBookingElevated(elevatedPayload);
    
    if (!bookingResult.ok) {
      throw createBookingError(ERROR_CODES.BOOKING_CREATION_FAILED, bookingResult.message);
    }
    
    // Actualizar con booking ID oficial
    const finalBooking = {
      ...currentBooking,
      bookingId: bookingResult.data.bookingId,
      status: "CONFIRMED",
      paymentStatus: "PAID",
      wixBookingId: bookingResult.data.bookingId,
      revision: bookingResult.data.revision,
      phase: 3,
      paymentConfirmedAt: new Date(),
      _updatedDate: new Date()
    };
    
    await wixData.update(CITAS_COLLECTION, finalBooking, { suppressAuth: true });
    
    // Liberar lock del slot si existe
    if (currentBooking.slotKey) {
      await _unlockSlotKey(currentBooking.slotKey, traceId);
    }
    
    return {
      ok: true,
      bookingId: bookingResult.data.bookingId,
      status: "CONFIRMED",
      phase: 3,
      completed: true
    };
    
  } catch (error) {
    log.error("[bookingCore] Phase 3 confirmation failed", { error: error.message, bookingId, traceId });
    
    // COMPENSACION: Marcar para revision manual
    await registerCompensation(bookingId, "PHASE_3_FAILED", error.message, traceId);
    
    return { 
      ok: false, 
      code: error.code || ERROR_CODES.COMPENSATION_FAILED, 
      message: error.message,
      requiresManualReview: true
    };
  }
}

/**
 * FASE 4: Cancelar reserva con compensacion
 */
export async function cancelBookingPhase4(bookingId, reason, traceId) {
  try {
    const currentBooking = await wixData.get(CITAS_COLLECTION, bookingId, { suppressAuth: true });
    
    if (!currentBooking) {
      throw createBookingError(ERROR_CODES.DATA_CONFLICT, "Reserva no encontrada");
    }
    
    // Cancelar en Wix Bookings si existe booking oficial
    if (currentBooking.wixBookingId) {
      const cancelResult = await cancelBookingElevated(currentBooking.wixBookingId);
      
      if (!cancelResult.ok) {
        log.warn("[bookingCore] Wix booking cancellation failed", { bookingId, error: cancelResult.message });
      }
    }
    
    // Actualizar estado local
    const cancelledBooking = {
      ...currentBooking,
      status: "CANCELLED",
      paymentStatus: currentBooking.paymentStatus === "PAID" ? "REFUNDED" : "CANCELLED",
      cancellationReason: reason,
      cancelledAt: new Date(),
      _updatedDate: new Date()
    };
    
    await wixData.update(CITAS_COLLECTION, cancelledBooking, { suppressAuth: true });
    
    // Liberar lock del slot
    if (currentBooking.slotKey) {
      await _unlockSlotKey(currentBooking.slotKey, traceId);
    }
    
    // Si hay pago, registrar reembolso pendiente
    if (currentBooking.paymentStatus === "PAID") {
      await registerCompensation(bookingId, "REFUND_PENDING", reason, traceId);
    }
    
    return {
      ok: true,
      bookingId,
      status: "CANCELLED",
      refundRequired: currentBooking.paymentStatus === "PAID"
    };
    
  } catch (error) {
    log.error("[bookingCore] Phase 4 cancellation failed", { error: error.message, bookingId, traceId });
    return { ok: false, code: ERROR_CODES.COMPENSATION_FAILED, message: error.message };
  }
}

// ============================================================================
// [BC-13] COMPENSACION - Registro de operaciones fallidas para recuperacion
// ============================================================================

/**
 * Registra operacion fallida para compensacion manual o automatica
 */
export async function registerCompensation(bookingId, phase, error, traceId) {
  try {
    const compensationRecord = {
      bookingId,
      phase,
      error: typeof error === 'object' ? JSON.stringify(error) : String(error),
      traceId,
      status: "PENDING",
      attempts: 0,
      lastAttempt: null,
      createdAt: new Date(),
      resolvedAt: null,
      resolution: null
    };
    
    await wixData.insert(COMPENSATIONS_COLLECTION, compensationRecord, { suppressAuth: true });
    log.warn("[bookingCore] Compensation registered", { bookingId, phase, traceId });
    
    return { ok: true, compensationId: compensationRecord._id };
  } catch (error) {
    log.error("[bookingCore] Failed to register compensation", { error: error.message, bookingId });
    return { ok: false, message: error.message };
  }
}

/**
 * Procesa compensaciones pendientes
 */
export async function processPendingCompensations(limit = 10) {
  try {
    const pending = await wixData.query(COMPENSATIONS_COLLECTION)
      .eq("status", "PENDING")
      .lt("attempts", 3)
      .limit(limit)
      .find({ suppressAuth: true });
    
    const results = { processed: 0, succeeded: 0, failed: 0 };
    
    for (const comp of (pending.items || [])) {
      results.processed++;
      
      try {
        comp.attempts++;
        comp.lastAttempt = new Date();
        
        // Logica de reintentos especifica por fase
        if (comp.phase === "PHASE_3_FAILED") {
          // Reintentar confirmacion
          const retryResult = await confirmBookingPhase3(comp.bookingId, {}, `retry_${comp.traceId}`);
          
          if (retryResult.ok) {
            comp.status = "RESOLVED";
            comp.resolution = "Auto-resolved on retry";
            results.succeeded++;
          } else {
            results.failed++;
          }
        } else if (comp.phase === "REFUND_PENDING") {
          // Marcar para procesamiento manual de reembolso
          comp.status = "REQUIRES_MANUAL_REVIEW";
          results.failed++; // Requiere intervencion
        }
        
        await wixData.update(COMPENSATIONS_COLLECTION, comp, { suppressAuth: true });
        
      } catch (error) {
        log.error("[bookingCore] Compensation processing failed", { compensationId: comp._id, error: error.message });
        comp.status = "FAILED";
        comp.error = error.message;
        await wixData.update(COMPENSATIONS_COLLECTION, comp, { suppressAuth: true });
        results.failed++;
      }
    }
    
    return { ok: true, results };
  } catch (error) {
    log.error("[bookingCore] Failed to process compensations", { error: error.message });
    return { ok: false, message: error.message };
  }
}