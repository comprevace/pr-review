package demo;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SessionCheckTest {

  @Test
  void rejectsExpiredSession() {
    assertFalse(new SessionCheck().isExpired(30));
    assertTrue(new SessionCheck().isExpired(31));
  }
}
