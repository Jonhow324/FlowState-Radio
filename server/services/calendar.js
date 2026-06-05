// services/calendar.js — Calendar provider (Mock adapter for Phase 2)
// Implements CalendarProvider interface with mock data

const logger = require('../utils/logger');

class MockCalendarAdapter {
  async getTodayEvents() {
    // Phase 2: Return empty events
    // Future: integrate with Notion/Google Calendar/iCal
    return [];
  }

  async getUpcomingEvents(minutesAhead = 30) {
    return [];
  }
}

const adapter = new MockCalendarAdapter();

async function getTodayEvents() {
  return adapter.getTodayEvents();
}

async function getUpcomingEvents(minutesAhead) {
  return adapter.getUpcomingEvents(minutesAhead);
}

async function getEventsDescription() {
  const events = await getTodayEvents();
  if (events.length === 0) {
    return '今天没有日程安排。';
  }
  return `今天有 ${events.length} 个日程：` +
    events.map((e) => `${e.startTime} ${e.title}`).join('，');
}

module.exports = {
  getTodayEvents,
  getUpcomingEvents,
  getEventsDescription,
};
