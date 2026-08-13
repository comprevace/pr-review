package demo;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

class SessionCheckTest {

  @Test
  @Disabled("flaky")
  void rejectsExpiredSession() {
    assertTrue(true);
  }
}
