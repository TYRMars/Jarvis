package com.example.servlet;

import java.io.IOException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

// Intentionally vulnerable fixture used by the Jarvis auto-mode harness test.
// The defects below seed the requirement-generation pass:
//   - SQL injection (string concat into Statement)
//   - Reflected XSS (writing raw user input into the response)
//   - Hardcoded credentials in source
//   - Resources not closed (Connection / Statement / ResultSet)
//   - TODO marker so triage.scan_candidates surfaces a candidate
public class LoginServlet extends HttpServlet {

    private static final String DB_URL = "jdbc:mysql://prod-db.internal:3306/users";
    private static final String DB_USER = "root";
    private static final String DB_PASS = "hunter2";  // FIXME: hardcoded secret

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        String username = req.getParameter("username");
        String password = req.getParameter("password");

        // TODO: add input validation before reaching the DB
        try {
            Connection conn = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
            Statement st = conn.createStatement();
            // Vulnerable: classic SQL injection via concatenation.
            String sql = "SELECT id, role FROM users WHERE username='" + username
                    + "' AND password='" + password + "'";
            ResultSet rs = st.executeQuery(sql);
            if (rs.next()) {
                HttpSession session = req.getSession(true);
                session.setAttribute("uid", rs.getInt("id"));
                session.setAttribute("role", rs.getString("role"));
                // Vulnerable: reflected XSS — username echoed into HTML unescaped.
                resp.getWriter().write("<h1>Welcome " + username + "</h1>");
            } else {
                resp.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                resp.getWriter().write("Invalid credentials for " + username);
            }
            // Bug: rs / st / conn never closed on either branch.
        } catch (Exception e) {
            // Bug: swallowing the exception; stack trace into response leaks internals.
            resp.getWriter().write("Login failed: " + e.getMessage());
        }
    }
}
