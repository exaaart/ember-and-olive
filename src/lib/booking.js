// Бронирование столика.
//
// Интеграция включается переменной окружения VITE_BOOKING_ENDPOINT (см. .env.example):
// на этот адрес уходит POST с JSON заявки. Пока переменная не задана, сайт честно
// сообщает гостю, что онлайн-бронь не подключена, и ничего никуда не отправляет.

const endpoint = (import.meta.env.VITE_BOOKING_ENDPOINT || '').trim()
export const bookingConfigured = endpoint.length > 0

export const MAX_GUESTS = 12
export const BOOKING_DAYS_AHEAD = 60

// Слоты: 12:00–22:00 каждые 30 минут (кухня до 22:30)
export const timeSlots = (() => {
  const out = []
  for (let h = 12; h <= 22; h++) {
    out.push(`${String(h).padStart(2, '0')}:00`)
    if (h < 22) out.push(`${String(h).padStart(2, '0')}:30`)
  }
  return out
})()

export function toISODate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function dateLimits(now = new Date()) {
  const max = new Date(now)
  max.setDate(max.getDate() + BOOKING_DAYS_AHEAD)
  return { min: toISODate(now), max: toISODate(max) }
}

/** Свободные слоты на дату: для сегодняшнего дня — не раньше чем через час. */
export function slotsFor(dateISO, now = new Date()) {
  if (!dateISO || dateISO !== toISODate(now)) return timeSlots
  const minutesNow = now.getHours() * 60 + now.getMinutes() + 60
  return timeSlots.filter((t) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m >= minutesNow
  })
}

export function phoneDigits(value) {
  let d = String(value || '').replace(/\D/g, '')
  if (d.startsWith('8')) d = '7' + d.slice(1)
  if (d && !d.startsWith('7')) d = '7' + d
  return d.slice(0, 11)
}

export function formatPhone(value) {
  const d = phoneDigits(value)
  if (!d) return ''
  const p = d.slice(1)
  let out = '+7'
  if (p.length > 0) out += ' (' + p.slice(0, 3)
  if (p.length >= 3) out += ')'
  if (p.length > 3) out += ' ' + p.slice(3, 6)
  if (p.length > 6) out += '-' + p.slice(6, 8)
  if (p.length > 8) out += '-' + p.slice(8, 10)
  return out
}

export function validateBooking(f, now = new Date()) {
  const e = {}
  const name = (f.name || '').trim()
  if (name.length < 2) e.name = 'Укажите имя — так мы обратимся к вам при подтверждении.'

  if (phoneDigits(f.phone).length !== 11) e.phone = 'Введите номер полностью: +7 и ещё 10 цифр.'

  const { min, max } = dateLimits(now)
  if (!f.date) e.date = 'Выберите дату визита.'
  else if (f.date < min) e.date = 'Эта дата уже прошла. Выберите сегодняшнюю или более позднюю.'
  else if (f.date > max) e.date = `Бронируем не дальше чем на ${BOOKING_DAYS_AHEAD} дней вперёд.`

  if (!f.time) e.time = 'Выберите время.'
  else if (f.date && !slotsFor(f.date, now).includes(f.time))
    e.time = 'На это время сегодня уже не успеть. Выберите время позже.'

  const g = Number(f.guests)
  if (!Number.isInteger(g) || g < 1) e.guests = 'Укажите количество гостей.'
  else if (g > MAX_GUESTS) e.guests = `Онлайн — до ${MAX_GUESTS} гостей. Для большой компании позвоните нам.`

  if ((f.comment || '').length > 500) e.comment = 'Комментарий — до 500 символов.'
  if (!f.consent) e.consent = 'Нужно согласие на обработку данных, чтобы мы могли связаться с вами.'
  return e
}

/**
 * @returns {Promise<{status: 'sent'} | {status: 'not_configured'} | {status: 'error', message: string}>}
 */
export async function submitBooking(f) {
  if (!bookingConfigured) return { status: 'not_configured' }
  const payload = {
    name: f.name.trim(),
    phone: '+' + phoneDigits(f.phone),
    date: f.date,
    time: f.time,
    guests: Number(f.guests),
    comment: (f.comment || '').trim(),
    source: 'website',
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (!res.ok) return { status: 'error', message: `Система бронирования ответила ошибкой (${res.status}).` }
    return { status: 'sent' }
  } catch {
    return { status: 'error', message: 'Не удалось связаться с системой бронирования.' }
  } finally {
    clearTimeout(timer)
  }
}
